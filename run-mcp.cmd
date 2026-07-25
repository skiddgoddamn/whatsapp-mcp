@echo off
rem Pin CWD to this repo so auth_info/ and data/ are consistent
rem whether launched manually (QR auth) or by Claude Code (MCP stdio).
cd /d "%~dp0"
node src\main.ts %*
