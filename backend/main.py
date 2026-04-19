"""
Document Forgery Detection API  — v2 (Improved Detection Engine)
=================================================================
Uses multiple independent signals instead of a single ELA mean:

  1. Block-level ELA variance   — genuine images have UNIFORM error across blocks;
                                  tampered regions stand out as outlier blocks.
  2. Multi-quality ELA ghost    — compares Q70 vs Q90 re-saves; edited regions
                                  show inconsistent error at different qualities.
  3. Noise-map consistency      — Laplacian residual noise should be spatially
                                  homogeneous; inconsistency reveals compositing.
  4. Copy-move detection        — ORB feature matching finds duplicated regions.
  5. EXIF metadata analysis     — checks for missing / suspicious EXIF fields.
  6. PDF font + metadata checks — via PyMuPDF.
  7. OCR confidence analysis    — Tesseract (eng+hin+tam).
"""

import io, base64, logging, os, re, struct, time, asyncio
from typing import Optional, List
from threading import Thread
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

import cv2
import fitz           # PyMuPDF
import numpy as np
import threading
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, ImageEnhance, ExifTags

# ── EasyOCR Globals ──────────────────────────────────────────────────────────
_READER = None
_READER_LOCK = threading.Lock()

def get_easyocr_reader():
    global _READER
    if _READER is None:
        with _READER_LOCK:
            if _READER is None:
                import easyocr
                # Initialize English and Hindi models, running on CPU purely offline
                logger.info("Initializing EasyOCR Engine (Offline Mode)...")
                _READER = easyocr.Reader(['en', 'hi'], gpu=False)
    return _READER

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# ── FastAPI + CORS ────────────────────────────────────────────────────────────
app = FastAPI(title="Doc Forged AI API", description="Multi-signal document forgery detection.", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

# ── Constants ─────────────────────────────────────────────────────────────────
MAX_FILE_MB        = 20
MAX_FILE_BYTES     = MAX_FILE_MB * 1024 * 1024
SUPPORTED_TYPES    = {"image/jpeg","image/png","image/tiff","image/webp","image/bmp","application/pdf"}
FONT_MAX_ALLOWED   = 3
OCR_MIN_CONF       = 60
SCAN_WATCH_DIR     = "./scanned_docs"

# Ensure watch directory exists
os.makedirs(SCAN_WATCH_DIR, exist_ok=True)

# Forgery score weights (must sum to 1.0)
W_ELA      = 0.60
W_BLOCK    = 0.05
W_NOISE    = 0.05
W_COPYMOVE = 0.10
W_META     = 0.10
W_FONT     = 0.05
W_OCR      = 0.05

# Verdict thresholds (composite 0-100)
THRESH_FORGED     = 50   # ≥ 50 → FORGED
THRESH_SUSPICIOUS = 25   # ≥ 25 → SUSPICIOUS

SUSPICIOUS_SW = re.compile(
    r"(photoshop|gimp|inkscape|illustrator|affinity|acrobat|libreoffice|openoffice|paint\.net|canva|corel)",
    re.IGNORECASE,
)

# ── Utility ───────────────────────────────────────────────────────────────────
def img_to_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()

def _recompress(img_rgb: Image.Image, quality: int) -> np.ndarray:
    """Save img at JPEG quality, reload, return as float32 array."""
    buf = io.BytesIO()
    img_rgb.save(buf, format="JPEG", quality=quality)
    buf.seek(0)
    return np.array(Image.open(buf).convert("RGB"), dtype=np.float32)

def _ela_diff(orig_np: np.ndarray, quality: int, img_rgb: Image.Image) -> np.ndarray:
    recomp = _recompress(img_rgb, quality)
    return np.abs(orig_np - recomp)   # shape (H,W,3)


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Multi-quality ELA  (primary signal)
# ═══════════════════════════════════════════════════════════════════════════════
def run_ela(pil_img: Image.Image) -> dict:
    """
    ELA at two qualities (Q90 and Q70).

    Genuine JPEG:  high-error areas appear consistently at BOTH qualities.
    Tampered JPEG: spliced regions show disproportionately HIGH error at Q90
                   compared with Q70 (the JPEG ghost effect).

    Score is based on the *peak normalised ELA mean* (worst quality) and
    bonus if the Q90/Q70 error ratio is uneven (ghost signal).
    """
    img_rgb  = pil_img.convert("RGB")
    orig_np  = np.array(img_rgb, dtype=np.float32)

    diff_q90 = _ela_diff(orig_np, 90, img_rgb)
    diff_q70 = _ela_diff(orig_np, 70, img_rgb)

    mean_q90 = float(np.mean(diff_q90))
    mean_q70 = float(np.mean(diff_q70))

    # Ghost ratio: if Q90 error is disproportionately large vs Q70,
    # that indicates re-saved regions (a classic forgery tell).
    ghost_ratio = mean_q90 / max(mean_q70, 0.01)

    # Base ELA score: normalise Q90 mean against typical genuine range (0-2.0)
    # The ELA variance is the single best distinguishing feature because highly compressed WhatsApp images have LOW ELA
    ela_base = min(100.0, (mean_q90 / 2.0) * 100.0)

    # Ghost bonus: genuine = ghost_ratio ≈ 0.5-0.8; forged = ratio > 1.0
    ghost_bonus = 0.0
    if ghost_ratio > 1.2:
        ghost_bonus = min(40.0, (ghost_ratio - 1.2) * 50.0)

    ela_score = min(100.0, ela_base + ghost_bonus)

    # Build the visual heatmap from Q90 diff × brightness 20
    diff_img     = Image.fromarray(diff_q90.clip(0, 255).astype(np.uint8))
    ela_enhanced = ImageEnhance.Brightness(diff_img).enhance(20)
    
    # Resize heatmap to reduce size (max 400px width/height while maintaining aspect ratio)
    max_size = 400
    ela_enhanced.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

    # Contour-based flagged regions
    gray = cv2.cvtColor(np.array(diff_img), cv2.COLOR_RGB2GRAY)
    _, thr = cv2.threshold(gray, 8, 255, cv2.THRESH_BINARY)
    cnts, _ = cv2.findContours(thr, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_area = 0.002 * pil_img.width * pil_img.height
    flagged  = []
    for c in cnts:
        if cv2.contourArea(c) > min_area:
            x, y, w, h = cv2.boundingRect(c)
            flagged.append({"x":int(x),"y":int(y),"w":int(w),"h":int(h),
                            "reason":"High ELA error — possible tampering"})

    reasons = []
    if ela_score >= 60:
        reasons.append(f"ELA score is very high ({ela_score:.1f}/100) — strong evidence of image manipulation.")
    elif ela_score >= 30:
        reasons.append(f"ELA score is elevated ({ela_score:.1f}/100) — some regions show unusual compression artefacts.")
    if ghost_ratio > 1.2:
        reasons.append(f"JPEG ghost ratio {ghost_ratio:.2f} > 1.2 — indicates re-saved/spliced regions (typical of edited images).")

    return {
        "score":          round(ela_score, 2),
        "heatmap_b64":    img_to_b64(ela_enhanced),
        "flagged_regions":flagged[:10],
        "reasons":        reasons,
        "raw": {
            "mean_q90":    round(mean_q90, 4),
            "mean_q70":    round(mean_q70, 4),
            "ghost_ratio": round(ghost_ratio, 4),
        },
    }


# ═══════════════════════════════════════════════════════════════════════════════
# 2. Block-level ELA variance  (spatial uniformity check)
# ═══════════════════════════════════════════════════════════════════════════════
def run_block_ela(pil_img: Image.Image, block_size: int = 64) -> dict:
    """
    Divide the image into blocks and compute the ELA mean for each block.

    A genuine image has *uniform* ELA error: block means cluster tightly.
    A tampered image has high *variance* among block means because
    the forged region has a different compression history.

    Score = coefficient of variation (std/mean) of block ELA means,
            normalised to 0-100.
    """
    img_rgb = pil_img.convert("RGB")
    orig_np = np.array(img_rgb, dtype=np.float32)
    diff_np = _ela_diff(orig_np, 90, img_rgb)
    gray_diff = np.mean(diff_np, axis=2)   # (H, W)

    H, W = gray_diff.shape
    block_means = []
    flagged = []

    for y in range(0, H - block_size // 2, block_size):
        for x in range(0, W - block_size // 2, block_size):
            block = gray_diff[y:y+block_size, x:x+block_size]
            if block.size == 0:
                continue
            block_means.append(float(np.mean(block)))

    if len(block_means) < 4:
        return {"score": 0.0, "reasons": [], "flagged_regions": []}

    arr  = np.array(block_means)
    mean = float(np.mean(arr))
    std  = float(np.std(arr))
    cv   = std / max(mean, 0.01)    # coefficient of variation

    # Normalise CV to 0-100: genuine ≈ CV < 0.5; forged ≈ CV > 1.0
    # Lessened multiplier to 25 so normal highly compressed pictures aren't penalized heavily
    score = min(100.0, cv * 25.0)

    # Flag outlier blocks (those with ELA mean > mean + 2*std)
    threshold_high = mean + 2.0 * std
    bx_idx = 0
    for y in range(0, H - block_size // 2, block_size):
        for x in range(0, W - block_size // 2, block_size):
            if bx_idx < len(block_means) and block_means[bx_idx] > threshold_high:
                flagged.append({
                    "x":int(x),"y":int(y),
                    "w":int(min(block_size, W-x)),
                    "h":int(min(block_size, H-y)),
                    "reason": f"Block ELA outlier (mean={block_means[bx_idx]:.1f} vs image mean={mean:.1f})",
                })
            bx_idx += 1

    reasons = []
    if score >= 60:
        reasons.append(f"Block ELA variance is very high (CV={cv:.2f}) — strong sign that different image regions have different compression histories (copy-paste forgery).")
    elif score >= 30:
        reasons.append(f"Block ELA variance is elevated (CV={cv:.2f}) — some regions have inconsistent compression signatures.")

    return {
        "score":          round(score, 2),
        "reasons":        reasons,
        "flagged_regions":flagged[:10],
        "debug": {"cv": round(cv, 4), "mean": round(mean, 4), "std": round(std, 4)},
    }


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Noise map consistency (Laplacian residual analysis)
# ═══════════════════════════════════════════════════════════════════════════════
def run_noise_analysis(pil_img: Image.Image, grid: int = 4) -> dict:
    """
    Extract camera-noise via Laplacian high-pass filter and measure
    spatial consistency across image quadrants.

    Genuine photo: camera sensor noise is statistically uniform.
    Spliced image: pasted region has a different noise distribution
                   (camera model, ISO, compression, etc.).

    Score = normalised standard deviation of per-cell noise variances.
    """
    gray = np.array(pil_img.convert("L"), dtype=np.float32)
    # Laplacian extracts high-frequency residual (noise)
    noise = cv2.Laplacian(gray.astype(np.uint8), cv2.CV_64F)
    H, W  = noise.shape

    cell_h = H // grid
    cell_w = W // grid
    variances = []
    for row in range(grid):
        for col in range(grid):
            cell = noise[row*cell_h:(row+1)*cell_h, col*cell_w:(col+1)*cell_w]
            if cell.size > 0:
                variances.append(float(np.var(cell)))

    if len(variances) < 2:
        return {"score": 0.0, "reasons": [], "flagged_regions": []}

    arr      = np.array(variances)
    mean_var = float(np.mean(arr))
    std_var  = float(np.std(arr))
    cv       = std_var / max(mean_var, 0.001)

    # Genuine: CV < 0.8.  Forged: CV > 1.2 (for highly compressed chat app images)
    score = min(100.0, max(0.0, (cv - 0.8) / 0.4 * 100.0))

    # Flag cells with abnormally low or high noise variance
    low_thr   = mean_var - 1.5 * std_var
    high_thr  = mean_var + 1.5 * std_var
    flagged   = []
    idx = 0
    for row in range(grid):
        for col in range(grid):
            v = variances[idx] if idx < len(variances) else mean_var
            if v < max(low_thr, 0) or v > high_thr:
                flagged.append({
                    "x": int(col * cell_w), "y": int(row * cell_h),
                    "w": int(cell_w),       "h": int(cell_h),
                    "reason": f"Noise variance outlier ({v:.1f} vs mean {mean_var:.1f}) — possible splice boundary",
                })
            idx += 1

    reasons = []
    if score >= 60:
        reasons.append(f"Noise inconsistency score {score:.1f}/100 — camera sensor noise is not uniform across regions, strongly suggesting composite/spliced content.")
    elif score >= 30:
        reasons.append(f"Moderate noise inconsistency ({score:.1f}/100) — some image regions have different noise profiles.")

    return {"score": round(score, 2), "reasons": reasons,
            "flagged_regions": flagged[:8],
            "debug": {"cv": round(cv, 4), "mean_var": round(mean_var, 2)}}


# ═══════════════════════════════════════════════════════════════════════════════
# 4. Copy-move detection (ORB feature matching)
# ═══════════════════════════════════════════════════════════════════════════════
def run_copy_move(pil_img: Image.Image) -> dict:
    """
    Detect duplicated/cloned regions within the image.

    Strategy:
    - Extract ORB keypoints & descriptors from two halves of the image.
    - Match descriptors across halves with brute-force Hamming distance.
    - Suspiciously close matches (< distance threshold) that are spatially
      far apart from each other indicate copy-move forgery.

    Score = number of suspicious matches normalised to 0-100.
    """
    try:
        gray = np.array(pil_img.convert("L"))
        H, W = gray.shape

        orb = cv2.ORB_create(nfeatures=500)
        kps, des = orb.detectAndCompute(gray, None)

        if des is None or len(kps) < 10:
            return {"score": 0.0, "reasons": [], "flagged_regions": []}

        bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        matches = bf.match(des, des)

        # Filter: keep matches where descriptors are close (small distance)
        # BUT keypoints are far apart spatially (> 10% of image diagonal)
        diag = (H**2 + W**2) ** 0.5
        min_spatial = diag * 0.10
        suspicious = []
        for m in matches:
            if m.queryIdx == m.trainIdx:
                continue
            pt1 = np.array(kps[m.queryIdx].pt)
            pt2 = np.array(kps[m.trainIdx].pt)
            spatial_dist = float(np.linalg.norm(pt1 - pt2))
            if m.distance < 30 and spatial_dist > min_spatial:
                suspicious.append((pt1, pt2, m.distance))

        count = len(suspicious)
        score = min(100.0, count * 5.0)   # 20 matches → score 100

        flagged = []
        for pt1, pt2, dist in suspicious[:8]:
            flagged.append({
                "x": int(pt1[0]), "y": int(pt1[1]), "w": 20, "h": 20,
                "reason": f"Possible cloned region (ORB dist={dist}, Δ={int(np.linalg.norm(pt1-pt2))}px)",
            })

        reasons = []
        if score >= 60:
            reasons.append(f"Copy-move detection found {count} suspicious feature matches — strong indicator of cloned/duplicated content.")
        elif score >= 25:
            reasons.append(f"Copy-move detection found {count} potential cloned region matches — possible content duplication.")

        return {"score": round(score, 2), "reasons": reasons, "flagged_regions": flagged}

    except Exception as exc:
        logger.warning("Copy-move detection failed: %s", exc)
        return {"score": 0.0, "reasons": [], "flagged_regions": []}


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Metadata / EXIF analysis
# ═══════════════════════════════════════════════════════════════════════════════
def run_metadata_analysis(pil_img: Image.Image, file_bytes: bytes, is_pdf: bool) -> dict:
    """
    Inspect image EXIF or PDF metadata for forgery indicators:
    - Missing EXIF entirely (edited images often strip it)
    - EXIF software field pointing to an editor
    - Mismatched image dimensions vs EXIF recorded dimensions
    - Suspicious PDF creator/producer/author
    """
    score   = 0.0
    reasons = []

    if is_pdf:
        # PDF metadata handled in run_pdf_analysis; no EXIF here
        return {"score": 0.0, "reasons": []}

    # ─ EXIF extraction ────────────────────────────────────────────────────────
    exif_raw = None
    try:
        exif_raw = pil_img._getexif()          # returns None for PNGs, synthetic images
    except (AttributeError, Exception):
        pass

    if exif_raw is None:
        # Missing EXIF could mean the image was saved/exported by software,
        # but it's a mild signal (PNGs legitimately lack EXIF, and chat apps strip it).
        if pil_img.format == "JPEG":
            score += 5.0
            reasons.append("JPEG image has no EXIF metadata — genuine camera photos usually embed EXIF, but social media apps also strip it.")
        return {"score": min(100.0, round(score, 2)), "reasons": reasons}

    # ─ Decode EXIF tags ───────────────────────────────────────────────────────
    exif = {}
    for tag_id, value in exif_raw.items():
        tag = ExifTags.TAGS.get(tag_id, str(tag_id))
        exif[tag] = value

    # Software field
    software = str(exif.get("Software", "")).strip()
    if software and SUSPICIOUS_SW.search(software):
        score += 50.0
        reasons.append(f"EXIF 'Software' field is '{software}' — this image was processed by photo/vector editing software.")
    elif software and software.lower() not in ("", "none"):
        # Any listed software is a minor signal
        score += 10.0
        reasons.append(f"EXIF 'Software' field is '{software}'.")

    # Artist / ImageDescription can be injected
    for field in ("Artist", "ImageDescription", "Copyright"):
        val = str(exif.get(field, "")).strip()
        if val and SUSPICIOUS_SW.search(val):
            score += 20.0
            reasons.append(f"EXIF '{field}' contains editing software reference: '{val}'.")

    # Missing DateTimeOriginal while DateTimeDigitized is present → inconsistency
    dto = exif.get("DateTimeOriginal")
    dtd = exif.get("DateTimeDigitized")
    if dtd and not dto:
        score += 15.0
        reasons.append("EXIF has 'DateTimeDigitized' but no 'DateTimeOriginal' — possible metadata manipulation.")
    if dto and dtd and dto != dtd:
        score += 10.0
        reasons.append(f"EXIF DateTimeOriginal ({dto}) ≠ DateTimeDigitized ({dtd}) — possible re-save or metadata edit.")

    # Pixel dimension mismatch
    exif_w = exif.get("ExifImageWidth") or exif.get("PixelXDimension")
    exif_h = exif.get("ExifImageHeight") or exif.get("PixelYDimension")
    if exif_w and exif_h:
        actual_w, actual_h = pil_img.size
        if abs(int(exif_w) - actual_w) > 4 or abs(int(exif_h) - actual_h) > 4:
            score += 30.0
            reasons.append(f"EXIF dimensions ({exif_w}×{exif_h}) don't match actual image ({actual_w}×{actual_h}) — image may have been cropped or scaled after editing.")

    return {"score": min(100.0, round(score, 2)), "reasons": reasons}


# ═══════════════════════════════════════════════════════════════════════════════
# 6. PDF font + software metadata
# ═══════════════════════════════════════════════════════════════════════════════
def run_pdf_analysis(file_bytes: bytes) -> dict:
    reasons    = []
    font_score = 0.0
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
    except Exception as exc:
        return {"score": 0.0, "reasons": [f"Could not parse PDF: {exc}"], "fonts_found": [], "num_fonts": 0}

    all_fonts: set[str] = set()
    for page in doc:
        for font in page.get_fonts(full=True):
            name = font[3].strip()
            if name:
                all_fonts.add(name)
    num_fonts = len(all_fonts)
    if num_fonts > FONT_MAX_ALLOWED:
        excess = num_fonts - FONT_MAX_ALLOWED
        font_score += min(60.0, 20.0 + excess * 12.0)
        reasons.append(f"PDF uses {num_fonts} distinct fonts (expected ≤ {FONT_MAX_ALLOWED}). Mixing fonts often indicates text was pasted from multiple sources.")

    meta = doc.metadata or {}
    for field in ("creator", "producer", "author"):
        val = str(meta.get(field, "") or "")
        if SUSPICIOUS_SW.search(val):
            font_score += 40.0
            reasons.append(f"PDF metadata '{field}' = '{val}' — document was created/modified with editing software.")

    doc.close()
    return {"score": min(100.0, round(font_score, 2)), "fonts_found": sorted(all_fonts),
            "num_fonts": num_fonts, "reasons": reasons}


# ═══════════════════════════════════════════════════════════════════════════════
# 7. OCR anomaly
# ═══════════════════════════════════════════════════════════════════════════════
def run_ocr_analysis(pil_img: Image.Image) -> dict:
    reasons = []
    flagged = []
    
    try:
        # Preprocessing for better OCR accuracy
        ocr_ready = pil_img.convert("L")
        enhancer  = ImageEnhance.Contrast(ocr_ready)
        ocr_ready = enhancer.enhance(2.0)
        
        np_img = np.array(ocr_ready)
        
        # Load the offline OCR engine
        reader = get_easyocr_reader()
        # detail=1 returns [[x,y bounding box points], text, confidence]
        results = reader.readtext(np_img, detail=1)

        confs = []
        raw_text_parts = []
        
        for bbox, text, conf in results:
            text = str(text).strip()
            if not text:
                continue
                
            c = float(conf) * 100
            confs.append(c)
            raw_text_parts.append(text)
            
            if c < OCR_MIN_CONF:
                # Top-left and Bottom-right coordinates from polygon
                x1 = int(bbox[0][0])
                y1 = int(bbox[0][1])
                x2 = int(bbox[2][0])
                y2 = int(bbox[2][1])
                w = max(1, x2 - x1)
                h = max(1, y2 - y1)
                flagged.append({
                    "x": x1, "y": y1, "w": w, "h": h,
                    "reason": f"Low OCR confidence ({int(c)}%) on word '{text}'"
                })

        raw_text = " ".join(raw_text_parts)

        if not confs:
            return {
                "score": 0.0, "reasons": ["No readable text detected."], 
                "flagged_regions": [], "mean_confidence": None, 
                "low_conf_ratio": None, "raw_text": raw_text
            }

        mean_conf     = float(np.mean(confs))
        low_conf_ratio = sum(1 for c in confs if c < OCR_MIN_CONF) / len(confs)

        score = 0.0
        if low_conf_ratio > 0.4:
            score = 80.0
            reasons.append(f"{low_conf_ratio*100:.0f}% of words below OCR confidence threshold — text may be overlaid or blurred.")
        elif low_conf_ratio > 0.2:
            score = 40.0
            reasons.append(f"{low_conf_ratio*100:.0f}% of words have low OCR confidence — possible tampered text regions.")
        elif mean_conf < OCR_MIN_CONF:
            score = 20.0
            reasons.append(f"Overall OCR confidence is low ({mean_conf:.1f}%) — possible scan artefacts or image manipulation.")

        return {
            "score": round(score, 2), "mean_confidence": round(mean_conf, 2),
            "low_conf_ratio": round(low_conf_ratio * 100, 2),
            "flagged_regions": flagged[:10], "reasons": reasons,
            "raw_text": raw_text
        }

    except Exception as exc:
        logger.warning(f"OCR Engine offline error: {exc}")
        return {"score": 0.0, "reasons": [f"OCR failed: {exc}"], "flagged_regions": [], "raw_text": ""}

def infer_document_type(text: str, filename: str = "") -> str:
    """Classifies document type based on OCR text with a filename fallback."""
    t = text.lower()
    f = filename.lower()
    logger.info("OCR TEXT FOR DETECTION: %s", t[:200] + "..." if len(t) > 200 else t)
    
    # Combined check for text and filename to be ultra-robust
    def check(keywords):
        return any(k in t for k in keywords) or any(k in f for k in keywords)

    # Aadhaar Detection
    if check(["aadhaar", "uidai", "yob:", "dob:", "aadhare", "aadhar", "adhar"]):
        return "AADHAAR CARD"
    
    # PAN Card Detection
    if check(["permanent account", "income tax", "pan card", "pancard", "nsdl", "utiit"]):
        return "PAN CARD"
    
    # Passport Detection
    if check(["passport", "republic of india", "visa"]):
        return "PASSPORT"
    
    # Voter ID Detection
    if check(["voter id", "election commission", "epic card"]):
        return "VOTER ID CARD"
    
    # Driving License
    if check(["driving licence", "driving license", "dl no", "transport dept"]):
        return "DRIVING LICENSE"
        
    # Educational Certificate
    if check(["mark sheet", "marksheet", "university", "passing certificate", "degree"]):
        return "EDUCATIONAL CERTIFICATE"
        
    # Employment / Offer Letter
    if check(["offer letter", "appointment", "employment contract", "joining date"]):
        return "EMPLOYMENT LETTER"
        
    # Salary Slip
    if check(["payslip", "pay slip", "salary slip"]):
        return "SALARY SLIP"
        
    # Utility Bill / Invoice
    if check(["bill", "invoice", "receipt", "account summary"]):
        return "UTILITY BILL / INVOICE"
        
    if filename:
        import os
        name_only = os.path.splitext(filename)[0]
        # Clean up the filename for display (remove underscores, hyphens)
        clean_name = name_only.replace("_", " ").replace("-", " ")
        return f"{clean_name.upper()} (USER PROVIDED)"
        
    return "UNKNOWN DOCUMENT"


# ═══════════════════════════════════════════════════════════════════════════════
# Verdict aggregation
# ═══════════════════════════════════════════════════════════════════════════════
def compute_verdict(scores: dict, is_pdf: bool = False, is_webcam: bool = False) -> dict:
    """
    Weighted composite score → FORGED / SUSPICIOUS / GENUINE.

    Webcam mode: camera sensor noise + lens distortion + double-JPEG compression
    naturally inflate ELA, block_ela, and noise signals on GENUINE documents.
    We compensate by reducing their weights and raising verdict thresholds.
    """
    if is_webcam:
        # Camera physics explanation:
        #  - ELA: camera JPEG already has JPEG grid artifacts; re-saving at Q90 finds them everywhere → high score on genuine docs
        #  - Block ELA: camera bayer noise makes blocks uneven even for genuine shots
        #  - Noise: camera sensor produces real Laplacian noise — not forgery
        # Solution: heavily down-weight camera-physics signals, rely on structural & semantic signals
        composite = (
            scores["ela"]       * 0.15 +   # severely reduced — camera JPEG inflates this
            scores["block_ela"] * 0.05 +   # reduced for same reason
            scores["noise"]     * 0.05 +   # camera sensor noise is real but not forgery
            scores["copy_move"] * 0.35 +   # copy-move is camera-independent (pixel matching)
            scores["meta"]      * 0.25 +   # camera EXIF should be intact — high signal if missing
            scores["font"]      * 0.10 +   # font checks are document-structure-based
            scores["ocr"]       * 0.05
        )
        t_suspicious = 42.0   # raised — camera adds ~15-20pts naturally
        t_forged     = 68.0   # raised accordingly
    elif is_pdf:
        # PDF Synthetic Render weights
        composite = (
            scores["ela"]       * 0.70    +
            scores["block_ela"] * 0.0     +
            scores["noise"]     * 0.0     +
            scores["copy_move"] * 0.15    +
            scores["meta"]      * 0.05    +
            scores["font"]      * 0.05    +
            scores["ocr"]       * 0.05
        )
        t_suspicious = 30.0
        t_forged     = 55.0
    else:
        composite = (
            scores["ela"]       * W_ELA       +
            scores["block_ela"] * W_BLOCK     +
            scores["noise"]     * W_NOISE     +
            scores["copy_move"] * W_COPYMOVE  +
            scores["meta"]      * W_META      +
            scores["font"]      * W_FONT      +
            scores["ocr"]       * W_OCR
        )
        t_suspicious = THRESH_SUSPICIOUS
        t_forged     = THRESH_FORGED
        
    composite = min(100.0, round(composite, 2))

    if composite >= t_forged:
        verdict = "FORGED"
        conf = 92.0 + min(7.9, ((composite - t_forged) / max(0.1, 100.0 - t_forged)) * 7.9)
    elif composite >= t_suspicious:
        verdict = "SUSPICIOUS"
        conf = 78.0 + min(13.9, ((composite - t_suspicious) / max(0.1, t_forged - t_suspicious)) * 13.9)
    else:
        verdict = "GENUINE"
        conf = 99.9 - min(7.9, (composite / max(0.1, t_suspicious)) * 7.9)

    return {"verdict": verdict, "confidence": round(conf, 1), "composite": composite}


# ═══════════════════════════════════════════════════════════════════════════════
# PDF → PIL helper
# ═══════════════════════════════════════════════════════════════════════════════
def pdf_to_pil(file_bytes: bytes) -> Optional[Image.Image]:
    try:
        doc  = fitz.open(stream=file_bytes, filetype="pdf")
        page = doc[0]
        # Request alpha channel explicitly to capture native transparencies
        pix  = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=True)
        
        if pix.alpha:
            img = Image.frombytes("RGBA", [pix.width, pix.height], pix.samples)
            # Create a hard white background to replace the void
            bg = Image.new("RGB", img.size, (255, 255, 255))
            # Paste the PDF content over the white background using its own alpha mask
            bg.paste(img, mask=img.split()[3])
            final_img = bg
        else:
            final_img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            
        doc.close()
        return final_img
    except Exception as exc:
        logger.warning("PDF render failed: %s", exc)
        return None

# ── Analysis Utility (Shared) ─────────────────────────────────────────────────
async def process_file_analysis(filename: str, raw_bytes: bytes, source: str = "upload"):
    is_pdf = filename.lower().endswith(".pdf")
    is_webcam = (source == "webcam")
    
    pil_img = None
    if is_pdf:
        pil_img = pdf_to_pil(raw_bytes)
    else:
        try:
            pil_img = Image.open(io.BytesIO(raw_bytes))
        except Exception as exc:
            return {"error": f"Cannot decode image: {exc}"}

    if pil_img is None:
        return {"error": "Cannot render document to image."}

    # -- Signal Detectors --
    ela_r   = run_ela(pil_img)
    block_r = run_block_ela(pil_img)
    noise_r = run_noise_analysis(pil_img)
    cm_r    = run_copy_move(pil_img)
    meta_r  = run_metadata_analysis(pil_img, raw_bytes, is_pdf)

    pdf_render_b64 = img_to_b64(pil_img) if is_pdf else None
    if is_pdf:
        block_r["score"] = 0.0
        noise_r["score"] = 0.0
        block_r["reasons"], noise_r["reasons"] = [], []

    pdf_r = run_pdf_analysis(raw_bytes) if is_pdf else {"score":0.0,"reasons":[],"fonts_found":[],"num_fonts":0}
    ocr_r = run_ocr_analysis(pil_img)

    scores = {
        "ela": ela_r["score"], "block_ela": block_r["score"], "noise": noise_r["score"],
        "copy_move": cm_r["score"], "meta": meta_r["score"], "font": pdf_r["score"], "ocr": ocr_r["score"]
    }
    verdict_info = compute_verdict(scores, is_pdf, is_webcam)
    
    all_reasons = (ela_r.get("reasons", []) + block_r.get("reasons", []) + noise_r.get("reasons", []) + 
                   cm_r.get("reasons", []) + meta_r.get("reasons", []) + pdf_r.get("reasons", []) + ocr_r.get("reasons", []))
    all_flagged = (ela_r.get("flagged_regions", []) + block_r.get("flagged_regions", []) + 
                   noise_r.get("flagged_regions", []) + cm_r.get("flagged_regions", []) + ocr_r.get("flagged_regions", []))

    if not all_reasons:
        all_reasons = ["No significant forgery indicators detected. Document appears genuine."]

    doc_type = infer_document_type(ocr_r.get("raw_text", ""), filename)

    return {
        "verdict":    verdict_info["verdict"],
        "confidence": verdict_info["confidence"],
        "doc_type":   doc_type,
        "score_breakdown": {
            "ela_score":        scores["ela"],
            "block_ela_score":  scores["block_ela"],
            "noise_score":      scores["noise"],
            "copy_move_score":  scores["copy_move"],
            "meta_score":       scores["meta"],
            "font_score":       scores["font"],
            "ocr_score":        scores["ocr"],
        },
        "reasons":         all_reasons,
        "heatmap":         ela_r["heatmap_b64"],
        "flagged_regions": all_flagged[:15],
        "metadata": {
            "filename":           filename,
            "file_type":          "application/pdf" if is_pdf else "image/jpeg",
            "file_size_kb":       round(len(raw_bytes) / 1024, 2),
            "composite_score":    verdict_info["composite"],
            "ela_raw":            ela_r.get("raw", {}),
            "block_ela_debug":    block_r.get("debug", {}),
            "noise_debug":        noise_r.get("debug", {}),
            "ocr_mean_confidence":ocr_r.get("mean_confidence"),
            "ocr_low_conf_ratio": ocr_r.get("low_conf_ratio"),
            "pdf_fonts":          pdf_r.get("fonts_found", []),
            "pdf_num_fonts":      pdf_r.get("num_fonts", 0),
            "pdf_render_b64":     pdf_render_b64,
        },
    }

# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.post("/analyze")
async def analyze(file: UploadFile = File(...), source: str = Form("upload")):
    if file.content_type not in SUPPORTED_TYPES:
        raise HTTPException(400, f"Unsupported file type: {file.content_type}")
    
    raw = await file.read()
    if len(raw) > MAX_FILE_BYTES:
        raise HTTPException(413, f"File too large. Max {MAX_FILE_MB}MB.")

    payload = await process_file_analysis(file.filename, raw, source)
    if "error" in payload:
        raise HTTPException(422, payload["error"])
        
    return JSONResponse(content=payload)

# ── WebSockets for Scanner Integration ────────────────────────────────────────
active_connections: List[WebSocket] = []

@app.websocket("/ws/scans")
async def websocket_scanner(websocket: WebSocket):
    await websocket.accept()
    active_connections.append(websocket)
    try:
        while True:
            await websocket.receive_text() # Just keep connection alive
    except WebSocketDisconnect:
        active_connections.remove(websocket)

async def notify_new_scan(payload: dict):
    for connection in active_connections:
        try:
            await connection.send_json(payload)
        except:
            pass

# ── Watchdog Scanner Service ──────────────────────────────────────────────────
class ScannerHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory: return
        ext = os.path.splitext(event.src_path)[1].lower()
        if ext in [".pdf", ".jpg", ".jpeg", ".png", ".webp"]:
            time.sleep(1) # Give time for file to be fully written
            # Create a new event loop for this thread if needed, or use a queue
            asyncio.run(self.process_new_file(event.src_path))

    async def process_new_file(self, path):
        filename = os.path.basename(path)
        logger.info(f"Scanner Machine → New document detected: {filename}")
        try:
            with open(path, "rb") as f:
                raw = f.read()
            result = await process_file_analysis(filename, raw, source="scanner")
            if "error" not in result:
                await notify_new_scan(result)
        except Exception as e:
            logger.error(f"Scanner failure: {e}")

def start_scanner_watcher():
    handler = ScannerHandler()
    observer = Observer()
    observer.schedule(handler, SCAN_WATCH_DIR, recursive=False)
    observer.start()
    logger.info(f"Scanner Machine Service active. Watching directory: {SCAN_WATCH_DIR}")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

@app.on_event("startup")
async def startup_event():
    # Start the watcher in a separate thread
    watcher_thread = Thread(target=start_scanner_watcher, daemon=True)
    watcher_thread.start()


# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "version": "2.0.0"}


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
