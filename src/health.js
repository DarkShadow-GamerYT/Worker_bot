'use strict';

const http = require('http');

function sendJson(response, statusCode, data) {
  const body = JSON.stringify(data, null, 2);

  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(body);
}

function startHealthServer(options, getStatus) {
  if (!options.enabled) return null;

  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.url === '/') {
      sendJson(response, 200, getStatus());
      return;
    }

    sendJson(response, 404, { ok: false, error: 'Not found' });
  });

  server.listen(options.port, '0.0.0.0', () => {
    console.log(`Health server listening on port ${options.port}.`);
  });

  server.on('error', (error) => {
    console.error('Health server error:', error.message);
  });

  return server;
}

module.exports = {
  startHealthServer
};
