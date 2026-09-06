@echo off
chcp 65001 > NUL
title رفع مشروع مقياس زمن الرجع الحسي على GitHub
echo ========================================================
echo   أداة رفع مشروع مقياس زمن الرجع الحسي الإلكتروني على GitHub
echo ========================================================
echo.

where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [x] خطأ: برنامج Git غير مثبت على جهازك أو غير مضاف لمتغيرات النظام.
    echo.
    echo يرجى تحميل وتثبيت Git من الرابط التالي أولاً:
    echo https://git-scm.com/downloads
    echo.
    echo بعد التثبيت، أعد تشغيل هذا الملف.
    pause
    exit /b
)

echo [1/4] فحص مستودع Git...
if not exist ".git" (
    echo إنشاء مستودع Git محلي...
    git init
)

echo [2/4] إضافة وحفظ ملفات المشروع...
git add .
git commit -m "تحديثات المزامنة السحابية ومقياس زمن الرجع الحسي"

echo.
set /p REPO_URL="أدخل رابط مستودع GitHub الخاص بك (مثال: https://github.com/username/sensory-reaction-scale.git): "

if "%REPO_URL%"=="" (
    echo [x] لم يتم إدخال رابط! أعد تشغيل الملف وادخل الرابط الصحيح.
    pause
    exit /b
)

echo [3/4] ربط مستودع GitHub...
git branch -M main
git remote remove origin >nul 2>nul
git remote add origin %REPO_URL%

echo [4/4] جاري رفع الكود إلى GitHub...
git push -u origin main

if %errorlevel% equ 0 (
    echo.
    echo ========================================================
    echo   [✓] تم رفع المشروع بنجاح على GitHub!
    echo ========================================================
) else (
    echo.
    echo [x] تعذر الرفع تلقائياً. يُرجى مراجعة الدليل GITHUB_GUIDE.md للحصول على الخطوات التفصيلية.
)

pause
