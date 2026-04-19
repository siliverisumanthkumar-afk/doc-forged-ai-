# 🛡️ Doc Forged AI — AI Document Forgery Detector

A forensic-grade AI-powered dashboard to detect forged or tampered documents using **Error Level Analysis (ELA)**, **OCR anomaly detection**, and **font inconsistency checks**.

---

## 🚀 Quick Start (One Click!)

**Prerequisites:**
- ✅ [Python 3.9+](https://www.python.org/downloads/)
- ✅ [Node.js 18+](https://nodejs.org/)

**To run the project:**

> Simply double-click the **`START.bat`** file in the root folder.

This will automatically:
1. Install all backend dependencies (first time only)
2. Install all frontend dependencies (first time only)
3. Start the **Backend API** at `http://localhost:8000`
4. Start the **Frontend App** at `http://localhost:3000`
5. Open the browser for you 🎉

---

## 🧠 Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 14, React, TypeScript |
| **Backend** | FastAPI, Python 3.9+ |
| **AI Analysis** | ELA, OpenCV, PyMuPDF, Tesseract OCR |
| **Styling** | Glassmorphism + Cyber-themed CSS Animations |

---

## 🔬 How It Works

1. **Upload** a document (JPEG, PNG, PDF, etc.)
2. **AI Engine** runs multiple forensic checks:
   - 📊 **ELA Heatmap** — Detects inconsistent compression artifacts
   - 🔠 **OCR Analysis** — Identifies font/text anomalies
   - 📐 **Metadata Forensics** — Checks EXIF and document metadata
3. **Results Dashboard** shows a confidence score with a radial gauge
4. **Generate Certified Report** — Export a professional forensic report

---

## 📁 Project Structure

```
doc-forged-ai/
├── START.bat          # ← One-click launcher
├── backend/           # FastAPI server (port 8000)
│   ├── main.py
│   └── requirements.txt
└── frontend/          # Next.js app (port 3000)
    └── app/
        ├── page.tsx
        └── globals.css
```

---

*Built for national-level hackathon — IIT Trichy*