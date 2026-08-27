@echo off
REM Auto job-sync for eurojob-assistant. Runs npm run sync against the live Neon
REM database (DATABASE_URL in .env). Free: no AI, collection + scoring only.
cd /d C:\Users\ITS44\Desktop\Work\eurojob-assistant
echo ==== sync started %DATE% %TIME% ==== >> sync.log
call npm run sync >> sync.log 2>&1
echo ==== sync finished %DATE% %TIME% ==== >> sync.log
