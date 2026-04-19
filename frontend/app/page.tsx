"use client";

/**
 * Doc Forged AI — AI-powered Document Forgery Detection
 * Main page component
 *
 * Flow:
 *   idle  ──►  file selected  ──►  analyzing  ──►  results
 *                                                      │
 *                                               "Analyze another" resets to idle
 */

import React, { useCallback, useRef, useState, useEffect } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

type Verdict = "FORGED" | "SUSPICIOUS" | "GENUINE";

interface FlaggedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  reason: string;
}

interface AnalysisResult {
  verdict: Verdict;
  confidence: number;
  doc_type?: string;     // Automated identification (Aadhaar, PAN, etc.)
  score_breakdown: {
    ela_score: number;
    block_ela_score: number;
    noise_score: number;
    copy_move_score: number;
    meta_score: number;
    font_score: number;
    ocr_score: number;
  };
  reasons: string[];
  heatmap: string;               // base64 PNG
  flagged_regions: FlaggedRegion[];
  metadata: {
    filename: string;
    file_type: string;
    file_size_kb: number;
    composite_score: number;
    ela_raw: Record<string, number>;
    block_ela_debug: Record<string, number>;
    noise_debug: Record<string, number>;
    ocr_mean_confidence: number | null;
    ocr_low_conf_ratio: number | null;
    pdf_fonts: string[];
    pdf_num_fonts: number;
  };
}

type AppState = "idle" | "analyzing" | "results" | "error";

interface HistoryItem {
  id: string;
  timestamp: number;
  filename: string;
  result: AnalysisResult;
  isWebcam: boolean;
  originalB64?: string; // Stored base64 of the document for full recall
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

/**
 * Compresses a base64 image string to a smaller size for efficient history storage.
 * Scaled to max 800px width, quality 0.6
 */
async function compressImage(base64: string, maxWidth: number = 800): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(base64);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.6));
    };
    img.onerror = () => resolve(base64);
    img.src = base64;
  });
}

function verdictColor(v: Verdict) {
  if (v === "FORGED") return "#ef4444";
  if (v === "SUSPICIOUS") return "#f59e0b";
  return "#10b981";
}

function verdictDescription(v: Verdict) {
  if (v === "FORGED")
    return "Strong indicators of tampering were found. This document is likely not authentic.";
  if (v === "SUSPICIOUS")
    return "Some anomalies were detected. Manual verification is recommended.";
  return "No significant forgery indicators detected. This document appears authentic.";
}

// ─── Icons (inline SVG, no external deps) ────────────────────────────────────

const IconShield = () => (
  <svg width="28" height="28" fill="none" viewBox="0 0 24 24">
    <path
      d="M12 2L4 5v6c0 5.25 3.5 10.15 8 11.35C16.5 21.15 20 16.25 20 11V5L12 2z"
      fill="url(#shieldGrad)"
    />
    <defs>
      <linearGradient id="shieldGrad" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#3b82f6" />
        <stop offset="100%" stopColor="#8b5cf6" />
      </linearGradient>
    </defs>
  </svg>
);

const IconUpload = () => (
  <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="url(#upGrad)" strokeWidth="1.8">
    <defs>
      <linearGradient id="upGrad" x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stopColor="#3b82f6" />
        <stop offset="100%" stopColor="#8b5cf6" />
      </linearGradient>
    </defs>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12M8 8l4-4 4 4" />
  </svg>
);

const IconFile = () => (
  <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="#8b5cf6" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
    <polyline strokeLinecap="round" strokeLinejoin="round" points="14 2 14 8 20 8" />
  </svg>
);

const IconX = () => (
  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const IconWarn = ({ color }: { color: string }) => (
  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke={color} strokeWidth="2" style={{ flexShrink: 0 }}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
  </svg>
);

const IconScan = () => (
  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
  </svg>
);

const IconDownload = () => (
  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m-4-4l4 4 4-4" />
  </svg>
);

const IconRefresh = () => (
  <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M20.49 9A9 9 0 005.64 5.64L4 10M3.51 15a9 9 0 0014.85 3.36L20 14" />
  </svg>
);

function CyberCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = window.innerWidth;
    let height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;

    const particles: { x: number, y: number, vx: number, vy: number, z: number, s: number }[] = [];
    for (let i = 0; i < 150; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 1.5,
        vy: (Math.random() - 0.5) * 1.5,
        z: Math.random() * 2 + 0.5,
        s: Math.random() * 2.5 + 1
      });
    }

    let animationFrameId: number;

    const draw = () => {
      ctx.fillStyle = "#010308";
      ctx.fillRect(0, 0, width, height);

      particles.forEach((p, i) => {
        p.x += p.vx * p.z;
        p.y += p.vy * p.z;

        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.s * p.z * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(6, 182, 212, ${p.z / 3})`;
        ctx.fill();

        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p.x - p2.x;
          const dy = p.y - p2.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 150) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            const opacity = ((150 - dist) / 150) * ((p.z + p2.z) / 4);
            ctx.strokeStyle = `rgba(6, 182, 212, ${opacity})`;
            ctx.lineWidth = ((p.z + p2.z) / 4) * ((150 - dist) / 150);
            ctx.stroke();
          }
        }
      });
      animationFrameId = requestAnimationFrame(draw);
    };

    draw();

    const handleResize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width;
      canvas.height = height;
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 0, pointerEvents: 'none' }} />;
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────

function SkeletonLoader() {
  return (
    <div style={{ width: "100%" }}>
      <div className="skeleton skeleton-badge" style={{ margin: "0 auto 1.5rem" }} />
      <div className="scores-grid">
        <div style={{ height: "80px", borderRadius: "10px" }} className="skeleton" />
        <div style={{ height: "80px", borderRadius: "10px" }} className="skeleton" />
        <div style={{ height: "80px", borderRadius: "10px" }} className="skeleton" />
      </div>
      <div className="skeleton skeleton-block" style={{ borderRadius: "10px" }} />
    </div>
  );
}

// ─── Forensic Deep Scan Loader ──────────────────────────────────────────────
function ForensicScanLoader({ previewUrl }: { previewUrl: string | null }) {
  const [activeStep, setActiveStep] = useState(0);
  const [progress, setProgress] = useState(0);

  const steps = [
    { label: "ELA Spatial Matrix",         code: "ELA-7F2" },
    { label: "Block Noise Analysis",        code: "NZE-3C1" },
    { label: "Copy-Move Detection",         code: "CMV-9A4" },
    { label: "EXIF Metadata Scan",          code: "MET-1B8" },
    { label: "OCR Anomaly Clustering",      code: "OCR-5D6" },
    { label: "Font Inconsistency Check",    code: "FNT-2E9" },
    { label: "Computing Final Verdict",     code: "VRD-0F3" },
  ];

  const CIRCUMFERENCE = 2 * Math.PI * 42;

  useEffect(() => {
    let step = 0;
    const interval = setInterval(() => {
      if (step < steps.length) {
        step++;
        setActiveStep(step);
        setProgress(Math.round((step / steps.length) * 100));
      } else {
        clearInterval(interval);
      }
    }, 480);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="fscan-wrapper">
      {/* ── Header ── */}
      <div className="fscan-header">
        <div className="fscan-header-dot" />
        <span className="fscan-header-title">FORENSIC DEEP SCAN IN PROGRESS</span>
        <div className="fscan-header-dot" />
      </div>

      <div className="fscan-body">
        {/* ── Document preview with laser sweep ── */}
        <div className="fscan-preview-col">
          <div className="fscan-preview-frame">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Scanning document" className="fscan-preview-img" />
            ) : (
              <div className="fscan-preview-placeholder">
                <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="rgba(6,182,212,0.4)" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" />
                  <polyline strokeLinecap="round" strokeLinejoin="round" points="14 2 14 8 20 8" />
                </svg>
              </div>
            )}
            <div className="fscan-laser-line" />
            <div className="fscan-scan-overlay" />
            <div className="fscan-corner fscan-tl" />
            <div className="fscan-corner fscan-tr" />
            <div className="fscan-corner fscan-bl" />
            <div className="fscan-corner fscan-br" />
          </div>
          <p className="fscan-preview-label">Document under analysis</p>
        </div>

        {/* ── Step checklist ── */}
        <div className="fscan-steps-col">
          {steps.map((step, idx) => {
            const state = idx < activeStep ? "done" : idx === activeStep ? "active" : "pending";
            return (
              <div key={idx} className={`fscan-step fscan-step-${state}`}>
                <div className="fscan-step-indicator">
                  {state === "done" ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : state === "active" ? (
                    <div className="fscan-step-pulse" />
                  ) : (
                    <div className="fscan-step-idle" />
                  )}
                </div>
                <span className="fscan-step-label">{step.label}</span>
                <span className="fscan-step-code">{state === "done" ? "✓ OK" : state === "active" ? "SCANNING..." : step.code}</span>
              </div>
            );
          })}
        </div>

        {/* ── Radial progress ring ── */}
        <div className="fscan-ring-col">
          <div className="fscan-ring-wrapper">
            <svg width="120" height="120" className="fscan-ring-svg">
              <circle cx="60" cy="60" r="42" className="fscan-ring-bg" />
              <circle
                cx="60" cy="60" r="42"
                className="fscan-ring-fill"
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={CIRCUMFERENCE - (progress / 100) * CIRCUMFERENCE}
              />
            </svg>
            <div className="fscan-ring-inner">
              <span className="fscan-ring-pct">{progress}%</span>
              <span className="fscan-ring-sub">COMPLETE</span>
            </div>
          </div>
          <p className="fscan-ring-label">AI Analysis Progress</p>
        </div>
      </div>
    </div>
  );
}

// ─── Radial Gauge Component ──────────────────────────────────────────────────
function RadialGauge({ value, verdict, size = 180 }: { value: number, verdict: Verdict, size?: number }) {
  const radius = (size / 2) - 10;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;

  return (
    <div className="gauge-container">
      <svg width={size} height={size} className="gauge-svg">
        <circle
          className="gauge-bg"
          cx={size / 2}
          cy={size / 2}
          r={radius}
        />
        <circle
          className={`gauge-fill ${verdict}`}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="gauge-center">
        <div className={`gauge-percent ${verdict} gauge-pulse`}>{value}%</div>
        <div className="gauge-label">
          {verdict === 'GENUINE' ? 'Trust Score' : 'Forgery Confidence'}
        </div>
      </div>
    </div>
  );
}

// ─── Main page component ──────────────────────────────────────────────────────

export default function Home() {
  const [mounted, setMounted] = useState(false);
  
  useEffect(() => {
    setMounted(true);

    const handleMouseMove = (e: MouseEvent) => {
      document.documentElement.style.setProperty('--mouse-x', `${e.clientX}px`);
      document.documentElement.style.setProperty('--mouse-y', `${e.clientY}px`);
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // State
  const [appState, setAppState] = useState<AppState>("idle");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);
  const [imgNaturalSize, setImgNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [renderedSize, setRenderedSize] = useState<{ w: number; h: number } | null>(null);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [elaSensitivity, setElaSensitivity] = useState(0.85);

  // ── Webcam Scanner State ─────────────────────────────────────────────────
  const [webcamActive, setWebcamActive] = useState(false);
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  const [webcamError, setWebcamError] = useState<string>("");
  const [isWebcamCapture, setIsWebcamCapture] = useState(false);

  // ── History State ────────────────────────────────────────────────────────
  const [lastScanName, setLastScanName] = useState<string | null>(null);
  const [scannerStatus, setScannerStatus] = useState<"connected" | "disconnected" | "processing">("disconnected");
  
  // ─── WebSockets for Scanner Hub ─────────────────────────────────────────────
  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    const wsUrl = apiUrl.replace("http", "ws") + "/ws/scans";
    
    let socket: WebSocket;
    
    const connectWS = () => {
      socket = new WebSocket(wsUrl);
      
      socket.onopen = () => {
        setScannerStatus("connected");
        console.log("Scanner Hub: Connected to hardware gateway.");
      };
      
      socket.onmessage = async (event) => {
        const result = JSON.parse(event.data) as AnalysisResult;
        console.log("Scanner Hub: New document caught!", result.metadata.filename);
        
        setScannerStatus("processing");
        setLastScanName(result.metadata.filename);
        
        // Auto-save to history
        const newItem: HistoryItem = {
          id: Date.now().toString(),
          timestamp: Date.now(),
          filename: result.metadata.filename,
          result: result,
          isWebcam: false,
          originalB64: result.metadata.pdf_render_b64 || result.heatmap // Fallback for thumbnail
        };
        
        setHistory(prev => {
          const updated = [newItem, ...prev].slice(0, 20);
          localStorage.setItem("docforged_history", JSON.stringify(updated));
          return updated;
        });

        // Instant switch to results
        setResult(result);
        setAppState("results");
        setScannerStatus("connected");
      };
      
      socket.onclose = () => {
        setScannerStatus("disconnected");
        setTimeout(connectWS, 3000); // Reconnect loop
      };
    };

    connectWS();
    return () => socket?.close();
  }, []);

  // Load history from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("docforged_history");
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to load history", e);
      }
    }
  }, []);

  // Save history whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem("docforged_history", JSON.stringify(history));
    } catch (e) {
      console.warn("Storage quota exceeded. Clearing oldest records.", e);
      if (history.length > 5) {
        setHistory(prev => prev.slice(0, 5));
      }
    }
  }, [history]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const webcamCanvasRef = useRef<HTMLCanvasElement>(null);

  // ── File selection ───────────────────────────────────────────────────────

  const handleFile = useCallback((file: File) => {
    const supported = [
      "image/jpeg", "image/png", "image/tiff", "image/webp",
      "image/bmp", "application/pdf",
    ];
    if (!supported.includes(file.type)) {
      setErrorMsg(`Unsupported format "${file.type}". Please use JPEG, PNG, TIFF, WebP, BMP, or PDF.`);
      setAppState("error");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setErrorMsg("File is too large. Maximum allowed size is 20 MB.");
      setAppState("error");
      return;
    }

    setSelectedFile(file);
    setErrorMsg("");
    setAppState("idle");
    setResult(null);

    // Generate object URL for preview
    const objUrl = URL.createObjectURL(file);
    if (file.type.startsWith("image/")) {
      setPreviewUrl(objUrl);
    } else {
      setPreviewUrl(null); // PDF — show icon
    }
    setOriginalImageUrl(objUrl);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset input so the same file can be re-selected
    e.target.value = "";
  };

  const removeFile = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    setOriginalImageUrl(null);
    setResult(null);
    setAppState("idle");
    setErrorMsg("");
    setIsWebcamCapture(false);
  };

  // ── Webcam handlers ──────────────────────────────────────────────────────

  const startWebcam = async () => {
    setWebcamError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      setWebcamStream(stream);
      setWebcamActive(true);
      // Attach stream to video element after state update
      setTimeout(() => {
        if (webcamVideoRef.current) {
          webcamVideoRef.current.srcObject = stream;
          webcamVideoRef.current.play();
        }
      }, 100);
    } catch {
      setWebcamError("Camera access denied. Please allow camera permissions in your browser.");
    }
  };

  const stopWebcam = () => {
    if (webcamStream) {
      webcamStream.getTracks().forEach((t) => t.stop());
    }
    setWebcamStream(null);
    setWebcamActive(false);
    setWebcamError("");
  };

  const captureFrame = () => {
    const video = webcamVideoRef.current;
    const canvas = webcamCanvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], "webcam-capture.jpg", { type: "image/jpeg" });
      stopWebcam();
      setIsWebcamCapture(true); // Mark this file as a webcam capture
      handleFile(file);
    }, "image/jpeg", 0.95);
  };

  // ── Analysis ─────────────────────────────────────────────────────────────

  const analyze = async () => {
    if (!selectedFile) return;

    setAppState("analyzing");
    setResult(null);
    setErrorMsg("");

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("source", isWebcamCapture ? "webcam" : "upload");

    try {
      const res = await fetch(`${apiUrl}/analyze`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const detail = body?.detail || `Server returned ${res.status}`;
        throw new Error(detail);
      }

      const data: AnalysisResult = await res.json();
      setResult(data);
      setAppState("results");

      // Capture and COMPRESS original document base64 for history recall
      let originalB64 = "";
      if (selectedFile.type.startsWith("image/")) {
        const rawB64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(selectedFile);
        });
        originalB64 = await compressImage(rawB64);
      } else if (data.metadata.pdf_render_b64) {
        const rawPdfB64 = `data:image/jpeg;base64,${data.metadata.pdf_render_b64}`;
        originalB64 = await compressImage(rawPdfB64);
      }

      // Also compress the heatmap for storage
      const compressedHeatmap = await compressImage(`data:image/png;base64,${data.heatmap}`, 600);
      const optimizedData = { ...data, heatmap: compressedHeatmap.split(",")[1] };

      // Save to history
      const newItem: HistoryItem = {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: Date.now(),
        filename: selectedFile.name,
        result: optimizedData,
        isWebcam: isWebcamCapture,
        originalB64: originalB64,
      };
      setHistory((prev) => [newItem, ...prev].slice(0, 15)); // Keep last 15

      // Scroll to results after a brief paint delay
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error. Please try again.";
      setErrorMsg(msg);
      setAppState("error");
    }
  };

  const loadFromHistory = (item: HistoryItem) => {
    console.log("Loading from history:", item.filename);
    try {
      // Reconstruct essential state for the Results panel
      setErrorMsg(""); // Clear any previous errors
      setResult(item.result);
      setAppState("results");
      setShowHistory(false);

      // Set mock file metadata to keep UI logic consistent
      const mockFile = {
        name: item.filename,
        type: item.result.metadata.file_type || (item.filename.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/jpeg"),
        size: item.result.metadata.file_size_kb * 1024,
      } as File;
      setSelectedFile(mockFile);

      // Restore original image view
      if (item.originalB64) {
        setOriginalImageUrl(item.originalB64);
        setPreviewUrl(item.originalB64);
      } else {
        setOriginalImageUrl(null);
        setPreviewUrl(null);
      }
      
      // Scroll to results - Faster reveal
      setTimeout(() => {
        if (resultsRef.current) {
          resultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
        }
      }, 50);
    } catch (err) {
      console.error("Recall failed:", err);
      setErrorMsg("Failed to open archive item.");
      setShowHistory(false);
    }
  };

  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistory((prev) => prev.filter((h) => h.id !== id));
  };

  const clearHistory = () => {
    if (confirm("Are you sure you want to clear your entire archive?")) {
      setHistory([]);
    }
  };

  // ── Download report ──────────────────────────────────────────────────────

  const downloadReport = () => {
    if (!result) return;
    const { verdict, confidence, doc_type, score_breakdown, reasons, metadata } = result;

    const vColor = verdictColor(verdict);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>IIT Trichy CyberSec AI Report — ${metadata.filename}</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 750px; margin: 2rem auto; padding: 1rem 2rem; color: #111; }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  .meta { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .verdict { display: inline-block; padding: 0.5rem 1.5rem; border-radius: 999px;
             background: ${vColor}22; border: 2px solid ${vColor}; color: ${vColor};
             font-size: 1.4rem; font-weight: 800; letter-spacing: 0.08em; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
  td, th { padding: 0.55rem 0.75rem; border: 1px solid #ddd; text-align: left; font-size: 0.9rem; }
  th { background: #f5f5f5; font-weight: 700; }
  ul { padding-left: 1.5rem; }
  li { margin-bottom: 0.4rem; font-size: 0.9rem; }
  .footer { font-size: 0.75rem; color: #999; margin-top: 2rem; border-top: 1px solid #eee; padding-top: 0.75rem; }
</style>
</head>
<body>
<h1>🛡 IIT Trichy CyberSec AI — Forgery Analysis Report</h1>

<div style="margin: 1.5rem 0; padding: 1rem; background-color: #f8fafc; border-left: 4px solid #06b6d4; border-radius: 4px;">
  <h2 style="margin: 0 0 0.5rem 0; font-size: 1.2rem; color: #334155;">Document Identification</h2>
  <p style="margin: 0; font-size: 1.1rem;">Detected Type: <strong style="color: #0369a1; font-weight: 800;">${doc_type || metadata?.filename?.toUpperCase()}</strong></p>
</div>

<p class="meta">File: <strong>${metadata.filename}</strong> &nbsp;|&nbsp; Size: ${metadata.file_size_kb} KB &nbsp;|&nbsp; Generated: ${new Date().toLocaleString()}</p>
<div class="verdict">${verdict}</div>
<p><strong>${verdict === 'GENUINE' ? 'Authenticity' : 'Forgery'} Confidence:</strong> <strong>${confidence}%</strong></p>
<p style="font-size: 0.8rem; color: #666; margin-top: -0.5rem; margin-bottom: 2rem;">(Raw Composite Score: ${metadata?.composite_score ?? "N/A"})</p>
<h2>Score Breakdown</h2>
<table>
  <tr><th>Signal</th><th>Score (0–100)</th><th>Weight</th></tr>
  <tr><td>ELA (Error Level Analysis)</td><td>${score_breakdown.ela_score}</td><td>35%</td></tr>
  <tr><td>Block-level ELA Variance</td><td>${score_breakdown.block_ela_score}</td><td>20%</td></tr>
  <tr><td>Noise Map Consistency</td><td>${score_breakdown.noise_score}</td><td>15%</td></tr>
  <tr><td>Copy-Move Detection</td><td>${score_breakdown.copy_move_score}</td><td>10%</td></tr>
  <tr><td>EXIF / Metadata Anomaly</td><td>${score_breakdown.meta_score}</td><td>10%</td></tr>
  <tr><td>PDF Font Inconsistency</td><td>${score_breakdown.font_score}</td><td>5%</td></tr>
  <tr><td>OCR Confidence Anomaly</td><td>${score_breakdown.ocr_score}</td><td>5%</td></tr>
</table>
<h2>Findings</h2>
<ul>${reasons.map((r) => `<li>${r}</li>`).join("")}</ul>
<h2>Technical Metadata</h2>
<table>
  <tr><th>Property</th><th>Value</th></tr>
  <tr><td>ELA Raw Mean Pixel</td><td>${metadata.ela_raw_mean}</td></tr>
  <tr><td>OCR Mean Confidence</td><td>${metadata.ocr_mean_confidence ?? "N/A"}%</td></tr>
  <tr><td>OCR Low-Confidence Ratio</td><td>${metadata.ocr_low_conf_ratio ?? "N/A"}%</td></tr>
  <tr><td>PDF Font Count</td><td>${metadata.pdf_num_fonts || "N/A"}</td></tr>
  ${metadata.pdf_fonts?.length ? `<tr><td>Fonts Detected</td><td>${metadata.pdf_fonts.join(", ")}</td></tr>` : ""}
</table>
<div class="footer">Generated by IIT Trichy CyberSec AI AI Document Forgery Detection &bull; For informational purposes only.</div>
</body>
</html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    if (win) {
      win.focus();
      win.onload = () => win.print();
    }
  };

  // ── Image load handler for scaled flagged boxes ──────────────────────────

  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    setRenderedSize({ w: img.clientWidth, h: img.clientHeight });
  };

  // Recalculate rendered size on render (in case layout shifts)
  const computedScaleX =
    imgNaturalSize && renderedSize && imgNaturalSize.w > 0
      ? renderedSize.w / imgNaturalSize.w
      : 1;
  const computedScaleY =
    imgNaturalSize && renderedSize && imgNaturalSize.h > 0
      ? renderedSize.h / imgNaturalSize.h
      : 1;

  // ── Render ───────────────────────────────────────────────────────────────

  if (!mounted) {
    return <div style={{ minHeight: "100vh", background: "#030712" }} />;
  }

  return (
    <>
      <CyberCanvas />

      <div className="page-wrapper">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="header">

          <div className="header-top">
            <h1 className="header-logo" style={{ filter: 'drop-shadow(0 0 15px var(--accent-cyan))' }}>
              <IconShield />
              Doc Forged AI
            </h1>
            <div className={`scanner-status-badge ${scannerStatus}`}>
              <div className="pulse-dot" />
              <span>{scannerStatus === "connected" ? "SCANNER HUB: ACTIVE" : 
                     scannerStatus === "processing" ? "SCANNER HUB: ANALYZING..." : 
                     "SCANNER HUB: OFFLINE"}</span>
            </div>

            <button 
              className={`archive-toggle-btn ${showHistory ? 'active' : ''}`}
              onClick={() => setShowHistory(true)}
              aria-label="View Forensic Archive"
            >
              <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
              <span>Archive</span>
              {history.length > 0 && <span className="archive-badge">{history.length}</span>}
            </button>
          </div>
          <p className="header-tagline">
            Detect forged or tampered documents instantly using Error Level Analysis,
            OCR anomaly detection, and font inconsistency checks.
          </p>
        </header>

        {/* ── Upload card ─────────────────────────────────────────────── */}
        <div className="glass-card">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            id="file-input"
            accept="image/*,.pdf"
            style={{ display: "none" }}
            onChange={onFileInput}
          />

          {/* Hidden canvas for webcam capture */}
          <canvas ref={webcamCanvasRef} style={{ display: "none" }} />

          {/* ── WEBCAM SCANNER ── */}
          {!selectedFile && !webcamActive && (
            <div className="webcam-trigger-bar">
              <div className="webcam-trigger-decor" />
              <button
                id="webcam-scan-btn"
                className="webcam-trigger-btn"
                onClick={startWebcam}
                aria-label="Scan document with camera"
              >
                <span className="webcam-trigger-icon">
                  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.723v6.554a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                  </svg>
                </span>
                <span className="webcam-trigger-text">
                  <span className="webcam-trigger-label">LIVE SCAN</span>
                  <span className="webcam-trigger-sub">Scan document with camera</span>
                </span>

              </button>
              <div className="webcam-trigger-decor" style={{ transform: "scaleX(-1)" }} />
            </div>
          )}

          {webcamError && (
            <div className="webcam-error-msg" role="alert">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="#f87171" strokeWidth="2" style={{ flexShrink: 0 }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              {webcamError}
            </div>
          )}

          {/* ── LIVE CAMERA FEED ── */}
          {webcamActive && (
            <div className="webcam-panel">
              <div className="webcam-panel-header">
                <div className="webcam-panel-status">
                  <div className="webcam-live-dot" />
                  <span>LIVE SCAN MODE — Position document within frame</span>
                </div>
                <button className="webcam-close-btn" onClick={stopWebcam} aria-label="Close camera">✕ Close</button>
              </div>

              <div className="webcam-feed-wrapper">
                {/* Live video */}
                <video
                  ref={webcamVideoRef}
                  className="webcam-video"
                  autoPlay
                  muted
                  playsInline
                />

                {/* Laser sweep overlay */}
                <div className="webcam-laser-line" />

                {/* Targeting reticle overlay */}
                <div className="webcam-reticle">
                  <div className="reticle-corner reticle-tl" />
                  <div className="reticle-corner reticle-tr" />
                  <div className="reticle-corner reticle-bl" />
                  <div className="reticle-corner reticle-br" />
                  <div className="reticle-crosshair-h" />
                  <div className="reticle-crosshair-v" />
                  <p className="reticle-hint">ALIGN DOCUMENT HERE</p>
                </div>

                {/* Grid overlay */}
                <div className="webcam-grid-overlay" />
              </div>

              <button
                id="webcam-capture-btn"
                className="webcam-capture-btn"
                onClick={captureFrame}
              >
                <span className="webcam-capture-ring" />
                <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path strokeLinecap="round" d="M20.447 7.104A9 9 0 1112 3a9 9 0 018.447 4.104" />
                </svg>
                Capture &amp; Analyze Document
              </button>
            </div>
          )}

          {/* Divider between webcam and upload zone */}
          {!selectedFile && !webcamActive && (
            <div className="webcam-divider">
              <div className="webcam-divider-line" />
              <span className="webcam-divider-text">OR UPLOAD FILE</span>
              <div className="webcam-divider-line" />
            </div>
          )}

          {/* Drop zone (shown only when no file selected) */}
          {!selectedFile && !webcamActive && (
            <div
              id="drop-zone"
              className={`drop-zone${isDragging ? " drag-over" : ""}`}
              role="button"
              tabIndex={0}
              aria-label="Click or drop a file to upload"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => e.key === "Enter" && fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
            >
              <div className="neural-grid-bg" />
              
              {/* Technical Corners */}
              <div className="corner-decor top-left" />
              <div className="corner-decor top-right" />
              <div className="corner-decor bottom-left" />
              <div className="corner-decor bottom-right" />

              {/* Data Fragments (Floating Bits) */}
              <div className="data-fragment bit-1">1</div>
              <div className="data-fragment bit-2">0</div>
              <div className="data-fragment bit-3">1</div>
              <div className="data-fragment bit-4">0</div>

              <div className="drop-zone-icon">
                <div className="orbital-ring orbital-ring-1" />
                <div className="orbital-ring orbital-ring-2" />
                <div className="orbital-ring orbital-ring-3" />
                <IconUpload />
              </div>

              <p className="drop-zone-title">Drop your document here, or click to browse</p>
              <p className="drop-zone-subtitle">Supports images and PDFs up to 20 MB</p>
              
              <div className="drop-zone-formats">
                {["JPEG", "PNG", "TIFF", "WebP", "BMP", "PDF"].map((f) => (
                  <span key={f} className="format-chip">{f}</span>
                ))}
              </div>

              <div className="status-indicator">
                <div className="status-dot" />
                System Active: Ready for Analysis
              </div>
            </div>
          )}

          {/* File preview */}
          {selectedFile && (
            <div className="file-preview" id="file-preview">
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt="Selected document thumbnail"
                  className="file-preview-thumb"
                />
              ) : (
                <div className="file-preview-icon">
                  <IconFile />
                </div>
              )}
              <div className="file-preview-info">
                <div className="file-preview-name" title={selectedFile.name}>
                  {selectedFile.name}
                </div>
                <div className="file-preview-size">
                  {formatBytes(selectedFile.size)} &nbsp;·&nbsp;{" "}
                  {selectedFile.type || "application/pdf"}
                </div>
              </div>
              <button
                id="remove-file-btn"
                className="file-preview-remove"
                aria-label="Remove selected file"
                onClick={removeFile}
              >
                <IconX />
              </button>
            </div>
          )}

          {/* Error banner */}
          {appState === "error" && errorMsg && (
            <div className="error-banner" role="alert">
              <IconWarn color="#f87171" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Analyze button */}
          <button
            id="analyze-btn"
            className="btn-analyze"
            onClick={analyze}
            disabled={!selectedFile || appState === "analyzing"}
            aria-busy={appState === "analyzing"}
          >
            {appState === "analyzing" ? (
              <>
                <SpinnerSVG />
                Analyzing document…
              </>
            ) : (
              <>
                <IconScan />
                Analyze for Forgery
              </>
            )}
          </button>
        </div>

        {/* ── Results card ────────────────────────────────────────────── */}
        {(appState === "analyzing" || appState === "results") && (
          <div className={`glass-card ${appState === 'results' ? 'results-reveal' : ''}`} style={{ marginTop: "1.5rem" }} ref={resultsRef} id="results-panel">

            {appState === "analyzing" ? (
              <ForensicScanLoader previewUrl={previewUrl} />
            ) : result ? (
              <>
                {/* Verdict badge */}
                <div className="verdict-section">
                  <div id="verdict-badge" className={`verdict-badge ${result.verdict}`} aria-label={`Verdict: ${result.verdict}`}>
                    {result.verdict === "FORGED" && "⚠ "}
                    {result.verdict === "SUSPICIOUS" && "⚡ "}
                    {result.verdict === "GENUINE" && "✓ "}
                    {result.verdict}
                  </div>
                  <p className="verdict-label">{verdictDescription(result.verdict)}</p>
                </div>

                {/* Detected Document Type Badge */}
                {(result.doc_type || result.metadata?.filename) && (
                  <div className="doc-signature">
                    <span className="doc-signature-label">DOCUMENT SIGNATURE:</span>
                    <span className="doc-signature-value">{result.doc_type || result.metadata?.filename?.toUpperCase()}</span>
                  </div>
                )}

                <div className="divider" />

                {/* Sci-Fi Confidence Gauge */}
                <RadialGauge value={result.confidence} verdict={result.verdict} />

                {/* Score breakdown — 7 signals */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "0.75rem", marginBottom: "1.5rem" }} id="score-breakdown">
                  {([
                    { label: "ELA", val: result.score_breakdown.ela_score, color: "#3b82f6", tip: "Error Level Analysis (35%)" },
                    { label: "Block ELA", val: result.score_breakdown.block_ela_score, color: "#8b5cf6", tip: "Block-level ELA variance (20%)" },
                    { label: "Noise", val: result.score_breakdown.noise_score, color: "#06b6d4", tip: "Noise map consistency (15%)" },
                    { label: "Copy-Move", val: result.score_breakdown.copy_move_score, color: "#ef4444", tip: "Copy-move detection (10%)" },
                    { label: "Metadata", val: result.score_breakdown.meta_score, color: "#f59e0b", tip: "EXIF/metadata anomaly (10%)" },
                    { label: "Font", val: result.score_breakdown.font_score, color: "#ec4899", tip: "PDF font inconsistency (5%)" },
                    { label: "OCR", val: result.score_breakdown.ocr_score, color: "#10b981", tip: "OCR confidence anomaly (5%)" },
                  ] as const).map(({ label, val, color, tip }, idx) => (
                    <div key={label} className="score-card" title={tip} style={{ 
                      background: "var(--bg-800)", 
                      border: "1px solid var(--border)", 
                      borderRadius: "var(--radius-md)", 
                      padding: "0.85rem",
                      animationDelay: `${idx * 0.12}s` 
                    }}>
                      <div style={{ fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-secondary)", marginBottom: "0.3rem" }}>{label}</div>
                      <div style={{ fontSize: "1.3rem", fontWeight: 800, color, marginBottom: "0.4rem" }}>{val}</div>
                      <div style={{ height: "4px", background: "var(--bg-700)", borderRadius: "999px", overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${val}%`, background: color, borderRadius: "999px", transition: "width 1.2s cubic-bezier(0.4,0,0.2,1)" }} />
                      </div>
                    </div>
                  ))}
                </div>

                {/* Reasons */}
                <div className="reasons-section">
                  <div className="section-heading">
                    Findings
                  </div>
                  {result.reasons.map((reason, idx) => (
                    <div
                      key={idx}
                      className="reason-item"
                      style={{ animationDelay: `${0.8 + idx * 0.15}s` }}
                    >
                      <span className="reason-icon">
                        <IconWarn
                          color={
                            result.verdict === "FORGED"
                              ? "#ef4444"
                              : result.verdict === "SUSPICIOUS"
                                ? "#f59e0b"
                                : "#10b981"
                          }
                        />
                      </span>
                      <span>{reason}</span>
                    </div>
                  ))}
                </div>

                {/* ELA Heatmap overlay */}
                {result.heatmap && (
                  <div className="heatmap-section">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
                      <div className="section-heading" style={{ marginBottom: 0 }}>ELA Heatmap Overlay</div>
                      <label className="toggle-switch" id="heatmap-toggle">
                        <input
                          type="checkbox"
                          checked={showHeatmap}
                          onChange={() => setShowHeatmap(prev => !prev)}
                          aria-label="Toggle ELA heatmap overlay"
                        />
                        <span className="toggle-slider" />
                        <span className="toggle-label">{showHeatmap ? "ON" : "OFF"}</span>
                      </label>
                    </div>

                    {/* ELA Sensitivity Slider */}
                    {showHeatmap && selectedFile?.type.startsWith("image/") && (
                      <div className="sensitivity-control">
                        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--accent-cyan)', whiteSpace: 'nowrap' }}>
                          SCAN SENSITIVITY:
                        </span>
                        <input
                          type="range"
                          min="0.1"
                          max="1"
                          step="0.05"
                          className="sensitivity-slider"
                          value={elaSensitivity}
                          onChange={(e) => setElaSensitivity(parseFloat(e.target.value))}
                        />
                        <span style={{ fontSize: '0.75rem', fontWeight: 800, minWidth: '35px', textAlign: 'right', color: 'var(--text-primary)' }}>
                          {(elaSensitivity * 100).toFixed(0)}%
                        </span>
                      </div>
                    )}

                    <div
                      className={`heatmap-wrapper ${showHeatmap ? "show-laser" : ""}`}
                      id="heatmap-container"
                      style={{ position: "relative" }}
                    >
                      {/* Original document */}
                      {originalImageUrl && selectedFile?.type.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          ref={imgRef}
                          src={originalImageUrl}
                          alt="Original document"
                          className="heatmap-original"
                          onLoad={onImgLoad}
                        />
                      ) : (
                        // For PDFs: show heatmap directly as the main image
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          ref={imgRef}
                          src={result.metadata.pdf_render_b64 ? `data:image/jpeg;base64,${result.metadata.pdf_render_b64}` : `data:image/png;base64,${result.heatmap}`}
                          alt={result.metadata.pdf_render_b64 ? "PDF Document render" : "ELA heatmap of document"}
                          className="heatmap-original"
                          onLoad={onImgLoad}
                        />
                      )}

                      {/* ELA heatmap semi-transparent overlay (only for real images, toggleable) */}
                      {showHeatmap && selectedFile?.type.startsWith("image/") && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`data:image/png;base64,${result.heatmap}`}
                          alt="ELA heatmap overlay"
                          className="heatmap-overlay"
                          aria-hidden="true"
                          style={{ opacity: elaSensitivity }}
                        />
                      )}

                      {/* Flagged region bounding boxes (also toggleable) */}
                      {showHeatmap && result.flagged_regions.map((region, idx) => (
                        <div
                          key={idx}
                          className="flagged-box"
                          title={region.reason}
                          aria-label={`Flagged region: ${region.reason}`}
                          style={{
                            left: `${region.x * computedScaleX}px`,
                            top: `${region.y * computedScaleY}px`,
                            width: `${region.w * computedScaleX}px`,
                            height: `${region.h * computedScaleY}px`,
                          }}
                        />
                      ))}
                    </div>
                    <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.4rem", textAlign: "center" }}>
                      {showHeatmap
                        ? "Bright areas in the heatmap indicate higher error levels — possible signs of digital manipulation. Red boxes mark specific flagged regions."
                        : "Heatmap overlay is hidden. Toggle ON to see ELA analysis visualization."
                      }
                    </p>
                  </div>
                )}

                {/* Technical metadata (collapsible) */}
                {result.metadata && (
                  <details style={{ marginBottom: "1rem" }}>
                    <summary style={{ cursor: "pointer", fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.6rem", userSelect: "none" }}>
                      Technical Metadata
                    </summary>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
                      <tbody>
                        {[
                          ["Filename", result.metadata.filename],
                          ["File Size", `${result.metadata.file_size_kb} KB`],
                          ["ELA Q90 Mean", result.metadata.ela_raw?.mean_q90 ?? "N/A"],
                          ["ELA Ghost Ratio", result.metadata.ela_raw?.ghost_ratio ?? "N/A"],
                          ["Block ELA CV", result.metadata.block_ela_debug?.cv ?? "N/A"],
                          ["Noise CV", result.metadata.noise_debug?.cv ?? "N/A"],
                          ["OCR Mean Confidence", result.metadata.ocr_mean_confidence != null ? `${result.metadata.ocr_mean_confidence}%` : "N/A"],
                          ["OCR Low-Conf Ratio", result.metadata.ocr_low_conf_ratio != null ? `${result.metadata.ocr_low_conf_ratio}%` : "N/A"],
                          ["PDF Font Count", result.metadata.pdf_num_fonts || "N/A"],
                          ...(result.metadata.pdf_fonts?.length ? [["PDF Fonts", result.metadata.pdf_fonts.join(", ")]] : []),
                        ].map(([k, v]) => (
                          <tr key={String(k)}>
                            <td style={{ padding: "0.35rem 0.5rem", fontWeight: 600, color: "var(--text-secondary)", width: "40%", borderBottom: "1px solid var(--border)" }}>{k}</td>
                            <td style={{ padding: "0.35rem 0.5rem", color: "var(--text-primary)", borderBottom: "1px solid var(--border)", wordBreak: "break-all" }}>{String(v)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}

                {/* Action buttons */}
                <div className="actions-row">
                  <button id="download-report-btn" className="btn-analyze" onClick={downloadReport} style={{ background: 'linear-gradient(135deg, var(--accent-cyan), var(--accent-blue))', flex: 2 }}>
                    <IconDownload />
                    Generate Certified Report
                  </button>
                  <button
                    id="analyze-another-btn"
                    className="btn-secondary"
                    onClick={() => {
                      setAppState("idle");
                      setSelectedFile(null);
                      setPreviewUrl(null);
                      setOriginalImageUrl(null);
                      setResult(null);
                      setErrorMsg("");
                    }}
                  >
                    <IconRefresh />
                    Analyze Another
                  </button>
                </div>
              </>
            ) : null}
          </div>
        )}

        {/* Footer */}
        <footer className="footer">
          <p>&copy; {mounted ? new Date().getFullYear() : ""} Doc Forged AI &bull; IIT Trichy Hackathon Edition</p>
        </footer>

        {/* ── Forensic Archive Sidebar ───────────────────────────────────── */}
        <aside className={`history-sidebar ${showHistory ? "open" : ""}`}>
          <div className="history-overlay" onClick={() => setShowHistory(false)} />
          <div className="history-content">
            <div className="history-header">
              <h3>
                <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="var(--accent-cyan)" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Forensic Archive
              </h3>
              <button className="history-close-btn" onClick={() => setShowHistory(false)}>✕</button>
            </div>

            <div className="history-list">
              {history.length === 0 ? (
                <div className="history-empty">
                  <div className="history-empty-icon">📂</div>
                  <p>Your archive is empty.</p>
                  <span>Successful scans will appear here automatically.</span>
                </div>
              ) : (
                <>
                  <div className="history-actions">
                    <button className="history-clear-btn" onClick={clearHistory}>Clear All Records</button>
                  </div>
                  {history.map((item) => (
                    <div 
                      key={item.id} 
                      className="history-item" 
                      onClick={() => loadFromHistory(item)}
                    >
                      <div className="history-item-top">
                        <span className={`history-verdict-badge ${item.result.verdict}`}>
                          {item.result.verdict}
                        </span>
                        <span className="history-conf">
                          {item.result.confidence}% Conf.
                        </span>
                      </div>
                      <div className="history-item-body">
                        <div className="history-item-thumb">
                          <img src={`data:image/jpeg;base64,${item.result.heatmap}`} alt="Forensic Preview" />
                        </div>
                        <div className="history-item-meta">
                          <p className="history-filename">{item.filename}</p>
                          <span className="history-date">
                            {new Date(item.timestamp).toLocaleString([], { 
                              month: 'short', 
                              day: 'numeric', 
                              hour: '2-digit', 
                              minute: '2-digit' 
                            })}
                          </span>
                        </div>
                      </div>
                      <button 
                        className="history-item-delete" 
                        onClick={(e) => deleteHistoryItem(item.id, e)}
                        title="Remove from archive"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

// ── Spinner SVG ───────────────────────────────────────────────────────────────

function SpinnerSVG() {
  return (
    <svg
      width="18" height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className="spinner-svg"
    >
      <path
        strokeLinecap="round"
        d="M12 2a10 10 0 0 1 10 10"
        strokeOpacity="0.3"
      />
      <path
        strokeLinecap="round"
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
      />
    </svg>
  );
}
