const path=process.env.OPENAPI_TS || require('node:path').join(__dirname, '..', '..', '..', '..', 'ts') + '/'
const {parse,make}=require(path+'dist/openapi.js')
const text=require('fs').readFileSync(process.argv[2],'utf8')
const mb=()=>{global.gc();return (process.memoryUsage().heapUsed/1048576).toFixed(0)+'MB'}
let tn=make(); let raw=parse(text,{instance:tn,fast:false}); console.log('after parse',mb())
tn=null; console.log('instance dropped',mb())
const keep=raw; raw=null; console.log('still holding raw',mb(), Object.keys(keep).length)
