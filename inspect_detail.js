const dns = require('dns');
const axios = require('axios');

const originalLookup = dns.lookup;
dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (hostname === 'comix.to' || hostname.endsWith('.comix.to')) {
    const address = '104.21.49.220';
    if (options && options.all) {
      return callback(null, [{ address, family: 4 }]);
    }
    return callback(null, address, 4);
  }
  return originalLookup(hostname, options, callback);
};

axios.get('https://comix.to/title/g2rk-on-the-way-to-meet-mom', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Referer': 'https://comix.to/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
  }
}).then(r => {
  const match = r.data.match(/<script id="initial-data"([^>]*)>(.*?)<\/script>/s);
  if (match) {
    const data = JSON.parse(match[2]);
    const queries = data.queries;
    for(let k in queries) {
      console.log('Query Key:', k);
    }
  } else {
    console.log('No initial-data found. Output length:', r.data.length);
    console.log(r.data.substring(0, 500));
  }
}).catch(console.error);
