// server.js — Static file server + booking proxy
// Serves dist/ on port 4323 and proxies /api/booking → localhost:18789

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = 4323;
const DIST = path.join(__dirname, 'dist');
const PORTAL = path.join(__dirname, '../corneys-portal');
const WEBHOOK_URL = 'http://127.0.0.1:18789/plugins/webhooks/booking';
const WEBHOOK_TOKEN = 'd47b532a160127df8591d9766dd0b9844de97038f2a1bdf91e7f802963362502';

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

function webhookRequest(action, extraBody, res) {
  const body = JSON.stringify({ action, ...extraBody });
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
      'Content-Length': Buffer.byteLength(body)
    }
  };
  const proxy = http.request(WEBHOOK_URL, options, (pr) => {
    let data = '';
    pr.on('data', chunk => data += chunk);
    pr.on('end', () => {
      res.writeHead(pr.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(data);
    });
  });
  proxy.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Gateway unavailable' }));
  });
  proxy.write(body);
  proxy.end();
}

function proxyBooking(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const proxy = http.request(WEBHOOK_URL, options, (pr) => {
      res.writeHead(pr.statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      pr.pipe(res);
    });
    proxy.on('error', (e) => {
      console.error('Webhook proxy error:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gateway unavailable' }));
    });
    proxy.write(body);
    proxy.end();
  });
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  let filePath = path.join(DIST, urlPath);

  // Try exact path, then with .html, then directory index
  const candidates = [filePath, filePath + '.html', path.join(filePath, 'index.html')];
  let found = null;
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) { found = c; break; }
  }

  if (!found) {
    const notFound = path.join(DIST, '404.html');
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : 'Not found');
    return;
  }

  const ext = path.extname(found);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(found).pipe(res);
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' });
    return res.end();
  }

  // Booking proxy
  if (req.method === 'POST' && req.url === '/api/booking') {
    return proxyBooking(req, res);
  }

  // List bookings for portal
  if (req.method === 'GET' && req.url === '/api/bookings') {
    return webhookRequest('list_flows', {}, res);
  }

  // List all agent activity (all flows — front-end filters out booking ones)
  if (req.method === 'GET' && req.url === '/api/agent-activity') {
    return webhookRequest('list_flows', {}, res);
  }

  // Social queue — returns all flows; client filters by [SOCIAL prefix
  if (req.method === 'GET' && req.url === '/api/social-queue') {
    return webhookRequest('list_flows', {}, res);
  }

  // Agent stats — computed summary from all flows
  if (req.method === 'GET' && req.url === '/api/agent-stats') {
    const body = JSON.stringify({ action: 'list_flows' });
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WEBHOOK_TOKEN}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const proxy = http.request(WEBHOOK_URL, options, (pr) => {
      let data = '';
      pr.on('data', chunk => data += chunk);
      pr.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const flows = parsed.result?.flows || [];
          const now = Date.now();
          const week = 7 * 24 * 60 * 60 * 1000;
          const stats = {
            totalFlows: flows.length,
            last7days: flows.filter(f => f.createdAt && (now - f.createdAt) < week).length,
            byAgent: {
              website: flows.filter(f => f.goal && (
                f.goal.includes('[WEBSITE') ||
                f.goal.toLowerCase().includes('website-agent') ||
                f.goal.toLowerCase().includes('agent-portal-build') ||
                f.goal.toLowerCase().includes('corneys-website')
              )).length,
              social: flows.filter(f => f.goal && f.goal.includes('[SOCIAL')).length,
              booking: flows.filter(f => f.goal && f.goal.startsWith('New booking')).length
            },
            byStatus: {
              queued:    flows.filter(f => f.status === 'queued').length,
              succeeded: flows.filter(f => f.status === 'succeeded').length,
              failed:    flows.filter(f => f.status === 'failed' || f.status === 'cancelled').length
            },
            pendingSocial: flows.filter(f =>
              f.goal && f.goal.includes('[SOCIAL') && f.status === 'queued'
            ).length
          };
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(stats));
        } catch(e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to compute stats' }));
        }
      });
    });
    proxy.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gateway unavailable' }));
    });
    proxy.write(body);
    proxy.end();
    return;
  }

  // Create a flow (used for portal messages to agents)
  if (req.method === 'POST' && req.url === '/api/create-flow') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { goal } = JSON.parse(body);
        webhookRequest('create_flow', { goal, status: 'queued' }, res);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // Resolve (approve/decline) a booking — fetches current revision first
  if (req.method === 'POST' && req.url === '/api/bookings/resolve') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { flowId, action } = JSON.parse(body); // action: 'finish_flow' | 'fail_flow'
        const resolveAction = action === 'fail_flow' ? 'fail_flow' : 'finish_flow';
        // Step 1: get current revision
        const getBody = JSON.stringify({ action: 'get_flow', flowId });
        const getOpts = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WEBHOOK_TOKEN}`, 'Content-Length': Buffer.byteLength(getBody) }
        };
        const getReq = http.request(WEBHOOK_URL, getOpts, (getRes) => {
          let data = '';
          getRes.on('data', c => data += c);
          getRes.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const revision = parsed.result?.flow?.revision ?? 0;
              // Step 2: finish or fail with correct revision
              webhookRequest(resolveAction, { flowId, expectedRevision: revision }, res);
            } catch {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse flow revision' }));
            }
          });
        });
        getReq.on('error', () => { res.writeHead(502); res.end(JSON.stringify({ error: 'Gateway error' })); });
        getReq.write(getBody);
        getReq.end();
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // Send booking notification email
  if (req.method === 'POST' && req.url === '/api/bookings/notify') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { flowId, action, reason } = JSON.parse(body);
        // Get flow details
        const getBody = JSON.stringify({ action: 'get_flow', flowId });
        const getOpts = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${WEBHOOK_TOKEN}`, 'Content-Length': Buffer.byteLength(getBody) }
        };
        const getReq = http.request(WEBHOOK_URL, getOpts, (getRes) => {
          let data = '';
          getRes.on('data', c => data += c);
          getRes.on('end', () => {
            try {
              const flow = JSON.parse(data).result?.flow;
              const goal = flow?.goal || '';
              // Parse customer details from goal string
              const nameM = goal.match(/from (.+?) \u2014/);
              const emailM = goal.match(/Email: ([^\u2014\s]+)/);
              const vehicleM = goal.match(/\u2014 (.+?) \u2014 \d{4}-\d{2}-\d{2}/);
              const dateM = goal.match(/(\d{4}-\d{2}-\d{2})/);
              const workM = goal.match(/Work: (.+)$/);
              const custName = nameM ? nameM[1].trim() : 'Customer';
              const custEmail = emailM ? emailM[1].trim() : null;
              const vehicle = vehicleM ? vehicleM[1].trim() : '';
              const date = dateM ? new Date(dateM[1]).toLocaleDateString('en-AU',{day:'numeric',month:'long',year:'numeric'}) : '';
              const work = workM ? workM[1].trim() : '';
              if (!custEmail) {
                res.writeHead(200); res.end(JSON.stringify({ ok: true, note: 'No email address found' }));
                return;
              }
              let subject, emailBody;
              if (action === 'finish_flow') {
                subject = `Booking Confirmed — Corney's Automotive Services`;
                emailBody = `Hi ${custName},\n\nGreat news! Your booking request has been approved.\n\nDetails:\n  Vehicle: ${vehicle}\n  Service: ${work}\n  Preferred date: ${date}\n\nWe'll be in touch shortly to confirm the exact time. If you have any questions, please call us on (02) 6552 6131.\n\nSee you soon,\nCorney's Automotive Services\n16 Albert Lane, Taree NSW 2430\n(02) 6552 6131`;
              } else {
                subject = `Booking Update — Corney's Automotive Services`;
                emailBody = `Hi ${custName},\n\nThank you for getting in touch with Corney's Automotive Services.\n\nUnfortunately we're unable to confirm your booking request at this time.\n\nReason: ${reason || 'Please contact us directly for details.'}\n\nWe'd love to help you find a time that works — please give us a call on (02) 6552 6131 and we'll do our best to accommodate you.\n\nSorry for any inconvenience,\nCorney's Automotive Services\n16 Albert Lane, Taree NSW 2430\n(02) 6552 6131`;
              }
              // Send via osascript (Mail.app with Ace's outlook account)
              const safeSubject = subject.replace(/'/g, "'\\''");
              const safeBody = emailBody.replace(/'/g, "'\\''");
              const safeEmail = custEmail.replace(/'/g, "'\\''");
              const script = `osascript -e 'tell application "Mail" to set newMsg to make new outgoing message with properties {subject:"${safeSubject}", content:"${safeBody}", visible:false}' -e 'tell application "Mail" to tell newMsg to make new to recipient with properties {address:"${safeEmail}"}' -e 'tell application "Mail" to send newMsg'`;
              execSync(script, { timeout: 10000 });
              res.writeHead(200); res.end(JSON.stringify({ ok: true, sent_to: custEmail }));
            } catch(e) {
              console.error('Email send error:', e.message);
              res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
            }
          });
        });
        getReq.on('error', () => { res.writeHead(502); res.end('{}'); });
        getReq.write(getBody);
        getReq.end();
      } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    return;
  }

  // Portal — serve files from corneys-portal/ under /portal/
  if (req.url === '/portal' || req.url === '/portal/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(PORTAL, 'login.html')).pipe(res);
    return;
  }
  if (req.url.startsWith('/portal/')) {
    const portalPath = req.url.replace('/portal/', '').split('?')[0];
    const filePath = path.join(PORTAL, portalPath);
    // Security: ensure path stays within portal dir
    if (!filePath.startsWith(PORTAL)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Corney's website running on port ${PORT}`);
});
