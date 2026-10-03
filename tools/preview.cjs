const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'};
function serve(req,res){
  const pathname = new URL(req.url,'http://localhost').pathname;
  const file = path.resolve(root,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep) || !['.html','.css','.js','.png'].includes(path.extname(file))){res.writeHead(404);res.end();return}
  fs.readFile(file,(error,data)=>{
    res.writeHead(error?404:200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(error?'Archivo no encontrado':data);
  });
}
module.exports = serve;
if(require.main===module)http.createServer(serve).listen(4173,'127.0.0.1',()=>console.log('Vista previa: http://127.0.0.1:4173'));
