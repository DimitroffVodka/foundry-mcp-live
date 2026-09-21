@echo off

REM ---------------------------------------------------------------------------
REM Optional features (env-var gates).
REM   WRITE is OFF by default — uncomment to let tools change the world.
REM   EVAL  is ON  by default (`evaluate`: arbitrary JS in the Foundry browser
REM         context) — uncomment the =0 line to turn it off.
REM ---------------------------------------------------------------------------
REM set FOUNDRY_MCP_ALLOW_WRITE=1
REM set FOUNDRY_MCP_ALLOW_EVAL=0

echo Starting Foundry MCP Server...
echo MCP endpoint : http://127.0.0.1:3000/mcp
echo Foundry WS   : ws://127.0.0.1:3001
if "%FOUNDRY_MCP_ALLOW_WRITE%"=="1" echo World writes : ENABLED
if "%FOUNDRY_MCP_ALLOW_EVAL%"=="0" (echo evaluate     : disabled) else (echo evaluate     : ENABLED ^(arbitrary JS in Foundry context^))
echo.
echo Keep this window open while using Claude Desktop or Claude Code CLI.
echo Close it to stop the server.
echo.
node "%~dp0server.js"
pause
