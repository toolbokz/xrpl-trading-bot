const http = require('http');
const options = {
  hostname: '127.0.0.1',
  port: 3000,
  path: '/api/bot/wallet',
  method: 'GET',
  headers: { 'Accept': 'application/json' }
};
const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      console.log(JSON.stringify(JSON.parse(data), null, 2));
    } catch (e) {
      console.log(data);
    }
  });
});
req.on('error', (e) => { console.error(e.message); });
req.end();
