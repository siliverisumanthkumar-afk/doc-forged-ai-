@echo off
title Doc Forged AI - Starting...
color 0B

echo.
echo  ======================================================
echo    DOC FORGED AI - AI Document Forgery Detector
echo    Starting backend and frontend servers...
echo  ======================================================
echo.

:: ── Check Python ─────────────────────────────────────────────────
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Python not found. Please install Python 3.9+ from python.org
    pause
    exit /b
)

:: ── Check Node.js ────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Please install Node.js 18+ from nodejs.org
    pause
    exit /b
)

echo  [OK] Python and Node.js detected.
echo.

:: ── Setup Backend Venv (if not already done) ─────────────────────
if not exist "backend\venv\Scripts\activate.bat" (
    echo  [SETUP] Creating Python virtual environment...
    cd backend
    python -m venv venv
    cd ..
)

:: ── Install Backend Dependencies (if needed) ─────────────────────
echo  [SETUP] Installing backend dependencies...
cd backend
call venv\Scripts\activate.bat
pip install -r requirements.txt --quiet
cd ..

:: ── Install Frontend Dependencies (if needed) ────────────────────
if not exist "frontend\node_modules" (
    echo  [SETUP] Installing frontend dependencies (first time only)...
    cd frontend
    npm install --silent
    cd ..
)

echo.
echo  [STARTING] Launching Backend on http://localhost:8000
echo  [STARTING] Launching Frontend on http://localhost:3000
echo.

:: ── Start Backend in a new window ────────────────────────────────
start "Doc Forged AI - Backend" cmd /k "cd /d %~dp0backend && call venv\Scripts\activate.bat && echo [BACKEND] Running on http://localhost:8000 && uvicorn main:app --host 0.0.0.0 --port 8000"

:: ── Wait 3 seconds for backend to start ──────────────────────────
timeout /t 3 /nobreak >nul

:: ── Start Frontend in a new window ───────────────────────────────
start "Doc Forged AI - Frontend" cmd /k "cd /d %~dp0frontend && echo [FRONTEND] Running on http://localhost:3000 && npm run dev"

:: ── Wait for frontend to compile ─────────────────────────────────
timeout /t 6 /nobreak >nul

:: ── Open browser automatically ───────────────────────────────────
echo  [DONE] Opening Doc Forged AI in your browser...
start "" "http://localhost:3000"

echo.
echo  ======================================================
echo    Both servers are running!
echo    Frontend : http://localhost:3000
echo    Backend  : http://localhost:8000
echo    Close the terminal windows to stop the servers.
echo  ======================================================
echo.
pause
