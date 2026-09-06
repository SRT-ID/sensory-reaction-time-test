@echo off
chcp 65001 > NUL
title رفع مشروع مقياس زمن الرجع الحسي على GitHub
echo ========================================================
echo   أداة رفع مشروع مقياس زمن الرجع الحسي الإلكتروني على GitHub
echo ========================================================
echo.

set GIT_BIN=git
where git >nul 2>nul
if %errorlevel% neq 0 (
    if exist "C:\Users\Emad Abdelfatah\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe" (
        set "GIT_BIN=C:\Users\Emad Abdelfatah\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe"
    ) else (
        echo [x] خطأ: تعذر العثور على برنامج Git.
        echo يرجى تحميل وتثبيت Git من الرابط التالي أولاً: https://git-scm.com/downloads
        pause
        exit /b
    )
)

echo [1/3] فحص مستودع Git وتحديث التعديلات...
"%GIT_BIN%" branch -M main >nul 2>nul
"%GIT_BIN%" add .
"%GIT_BIN%" commit -m "تحديثات مقياس زمن الرجع الحسي الإلكتروني" >nul 2>nul

echo.
set /p REPO_URL="أدخل رابط مستودع GitHub الخاص بك (مثال: https://github.com/username/sensory-reaction-scale.git): "

if "%REPO_URL%"=="" (
    echo [x] لم يتم إدخال رابط! أعد تشغيل الملف وادخل الرابط الصحيح.
    pause
    exit /b
)

echo [2/3] ربط مستودع GitHub...
"%GIT_BIN%" remote remove origin >nul 2>nul
"%GIT_BIN%" remote add origin %REPO_URL%

echo [3/3] جاري رفع الكود إلى GitHub...
"%GIT_BIN%" push -u origin main

if %errorlevel% equ 0 (
    echo.
    echo ========================================================
    echo   [✓] تم رفع المشروع بنجاح إلى GitHub!
    echo ========================================================
) else (
    echo.
    echo [x] تعذر الرفع تلقائياً. يُرجى مراجعة الدليل GITHUB_GUIDE.md للحصول على التفاصيل.
)

pause
