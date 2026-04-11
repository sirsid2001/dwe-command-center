#!/bin/bash
# VPS Optimize — called by MC server dashboard button
ssh -i "$HOME/.ssh/remote_access_key" -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o BatchMode=yes root@86.48.27.45 \
  'apt-get clean 2>/dev/null
   journalctl --vacuum-time=7d 2>/dev/null
   docker system prune -f 2>/dev/null
   DISK=$(df -h / | tail -1 | awk "{print \$4}")
   MEM=$(free -m | awk "/Mem:/{print \$7}")
   echo "{\"ok\":true,\"steps\":[\"APT cache cleaned\",\"Journal logs trimmed 7d\",\"Docker pruned\",\"Disk free: ${DISK}\",\"RAM available: ${MEM}MB\"]}"' 2>/dev/null

if [ $? -ne 0 ]; then
  echo '{"ok":false,"error":"SSH connection failed"}'
fi
