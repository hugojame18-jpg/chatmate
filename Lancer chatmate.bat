@echo off
title chatmate
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js n'est pas installe ou pas dans le PATH.
  echo   Installe-le depuis https://nodejs.org puis relance ce fichier.
  echo.
  pause
  exit /b 1
)

echo.
echo   Demarrage de chatmate...
echo   Laisse cette fenetre ouverte tant que l'app est utilisee.
echo   Pour arreter : ferme cette fenetre.
echo.

start "" http://localhost:5190
node server.js

echo.
echo   Le serveur s'est arrete.
pause
