const os = require('os');
const dns = require('dns').promises;
const { exec } = require('child_process');

async function resolveClientInfo(req) {
    let clientIp = req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    if (typeof clientIp === 'string' && clientIp.includes(',')) {
        clientIp = clientIp.split(',')[0].trim();
    }
    clientIp = clientIp.replace(/^::ffff:/, '').trim();
    if (clientIp === '::1') clientIp = '127.0.0.1';

    // Check if loopback / local IP (server itself)
    if (clientIp === '127.0.0.1' || clientIp === 'localhost') {
        return {
            ip: clientIp,
            computername: os.hostname()
        };
    }

    let computername = '';
    // 1. Try DNS reverse lookup
    try {
        const hostnames = await dns.reverse(clientIp);
        if (hostnames && hostnames.length > 0) {
            computername = hostnames[0].split('.')[0];
        }
    } catch (_) {}

    // 2. If DNS didn't resolve hostname on LAN, try quick NetBIOS/WMI/ping lookup with short timeout
    if (!computername && process.platform === 'win32') {
        try {
            computername = await new Promise((resolve) => {
                exec(`powershell -NoProfile -Command "$h = (Resolve-DnsName -Name '${clientIp}' -Type PTR -ErrorAction SilentlyContinue).NameHost; if($h){$h.Split('.')[0]}else{(ping -a -n 1 -w 300 '${clientIp}' | Select-String 'Pinging ([^ ]+)' | ForEach-Object { $_.Matches.Groups[1].Value.Split('.')[0] })}"`, { timeout: 1500 }, (err, stdout) => {
                    resolve(stdout && stdout.trim() ? stdout.trim() : '');
                });
            });
        } catch (_) {}
    } else if (!computername && process.platform !== 'win32') {
        try {
            computername = await new Promise((resolve) => {
                exec(`nmblookup -A '${clientIp}' 2>/dev/null | grep '<00>' | grep -v 'GROUP' | head -n 1 | awk '{print $1}'`, { timeout: 1500 }, (err, stdout) => {
                    if (stdout && stdout.trim()) {
                        resolve(stdout.trim());
                    } else {
                        exec(`getent hosts '${clientIp}' | awk '{print $2}' | cut -d. -f1`, { timeout: 1000 }, (err2, stdout2) => {
                            resolve(stdout2 && stdout2.trim() ? stdout2.trim() : '');
                        });
                    }
                });
            });
        } catch (_) {}
    }

    return {
        ip: clientIp,
        computername: computername || clientIp
    };
}

module.exports = { resolveClientInfo };
