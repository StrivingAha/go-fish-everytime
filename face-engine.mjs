import {normalize} from './core.mjs';
export const TEMPLATE=[[38.2946,51.6963],[73.5318,51.5014],[56.0252,71.7366],[41.5493,92.3655],[70.7299,92.2041]];
// Least-squares similarity transform: (u,v)=(a*x-b*y+tx,b*x+a*y+ty).
export function alignment(points){
 if(points?.length!==5||!points.flat().every(Number.isFinite))throw new Error('无效关键点');
 const mean=p=>p.reduce((s,v)=>[s[0]+v[0]/5,s[1]+v[1]/5],[0,0]);
 const [sx,sy]=mean(points),[dx,dy]=mean(TEMPLATE);let den=0,dot=0,cross=0;
 points.forEach(([x,y],i)=>{x-=sx;y-=sy;const u=TEMPLATE[i][0]-dx,v=TEMPLATE[i][1]-dy;den+=x*x+y*y;dot+=x*u+y*v;cross+=x*v-y*u;});
 if(den<1e-5)throw new Error('关键点重合');const a=dot/den,b=cross/den,tx=dx-a*sx+b*sy,ty=dy-b*sx-a*sy;
 const error=Math.sqrt(points.reduce((sum,[x,y],i)=>sum+(a*x-b*y+tx-TEMPLATE[i][0])**2+(b*x+a*y+ty-TEMPLATE[i][1])**2,0)/5);
 return {a,b,tx,ty,error};
}
export function iou(a,b){const w=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)),h=Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));return w*h/(a.width*a.height+b.width*b.height-w*h);}
export function decodeYuNet(output,size,scale,width,height){
 const candidates=[];
 for(const stride of [8,16,32]){
  const cls=output[`cls_${stride}`].data,obj=output[`obj_${stride}`].data,boxes=output[`bbox_${stride}`].data,kps=output[`kps_${stride}`].data,cols=size/stride;
  for(let i=0;i<cls.length;i++){
   const score=Math.sqrt(Math.max(0,Math.min(1,cls[i]))*Math.max(0,Math.min(1,obj[i])));if(score<.65)continue;
   const col=i%cols,row=Math.floor(i/cols),w=Math.exp(boxes[4*i+2])*stride/scale,h=Math.exp(boxes[4*i+3])*stride/scale;
   const x=(col+boxes[4*i])*stride/scale-w/2,y=(row+boxes[4*i+1])*stride/scale-h/2;
   if(x+w<=0||y+h<=0||x>=width||y>=height||![x,y,w,h].every(Number.isFinite))continue;
   const points=Array.from({length:5},(_,j)=>[(col+kps[i*10+j*2])*stride/scale,(row+kps[i*10+j*2+1])*stride/scale]);
   candidates.push({detection:{box:{x,y,width:w,height:h},score},points});
  }
 }
 const kept=[];for(const f of candidates.sort((a,b)=>b.detection.score-a.detection.score).slice(0,500)){if(kept.every(k=>iou(k.detection.box,f.detection.box)<.3))kept.push(f);}
 return kept;
}
export class FaceEngine{
 constructor(){this.input=document.createElement('canvas');this.input.width=this.input.height=640;this.aligned=document.createElement('canvas');this.aligned.width=this.aligned.height=112;}
 async load(){
  if(this.recognizer)return;
  const ort=globalThis.ort;ort.env.wasm.wasmPaths=new URL('./vendor/',import.meta.url).href;ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
  const opts={executionProviders:['wasm'],graphOptimizationLevel:'all'};
  this.detector=await ort.InferenceSession.create(new URL('./models/yunet.onnx',import.meta.url).href,opts);
  this.recognizer=await ort.InferenceSession.create(new URL('./models/sface-int8.onnx',import.meta.url).href,opts);
 }
 tensor(canvas,rgb){const {width:w,height:h}=canvas;const pixels=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h).data,n=w*h,data=new Float32Array(n*3);for(let i=0;i<n;i++){data[i]=pixels[i*4+(rgb?0:2)];data[n+i]=pixels[i*4+1];data[n*2+i]=pixels[i*4+(rgb?2:0)];}return new globalThis.ort.Tensor('float32',data,[1,3,h,w]);}
 async locate(source,targetSize=640){
  const size=640,scale=Math.min(targetSize/source.width,targetSize/source.height),ctx=this.input.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,size,size);ctx.drawImage(source,0,0,source.width*scale,source.height*scale);
  const input=this.tensor(this.input,false);let output;
  try{output=await this.detector.run({[this.detector.inputNames[0]]:input});}finally{input.dispose();}
  try{return decodeYuNet(output,size,scale,source.width,source.height);}finally{Object.values(output).forEach(t=>t.dispose());}
 }
 async detect(source){
  const started=performance.now();
  let faces=await this.locate(source);
  // YuNet's training favors faces below ~300px. Retry at half scale for close-ups.
  if(!faces.length)faces=await this.locate(source,320);
  // Extra faces remain unverified and trigger protection; cap recognition work only.
  for(const [index,f]of faces.entries()){
   const box=f.detection.box;f.quality='';f.descriptor=null;
   if(index>=8){f.quality='入镜人数过多';continue;}
   if(Math.min(box.width,box.height)<60){f.quality='面部过小，请靠近摄像头';continue;}
   if(box.x<0||box.y<0||box.x+box.width>source.width||box.y+box.height>source.height){f.quality='面部位于识别范围边缘，请移入框内';continue;}
   let t;try{t=alignment(f.points);}catch{f.quality='关键点不可靠';continue;}
   if(t.error>16||Math.hypot(f.points[0][0]-f.points[1][0],f.points[0][1]-f.points[1][1])<12){f.quality='角度过大或五官不清晰，请轻微转回';continue;}
   const ac=this.aligned.getContext('2d');ac.setTransform(1,0,0,1,0,0);ac.fillStyle='#000';ac.fillRect(0,0,112,112);ac.setTransform(t.a,t.b,-t.b,t.a,t.tx,t.ty);ac.drawImage(source,0,0);ac.setTransform(1,0,0,1,0,0);
   const pixels=ac.getImageData(0,0,112,112).data;let sum=0,sq=0;for(let i=0;i<pixels.length;i+=4){const v=(pixels[i]+pixels[i+1]+pixels[i+2])/3;sum+=v;sq+=v*v;}const mean=sum/(112*112),std=Math.sqrt(sq/(112*112)-mean*mean);
   if(mean<30||mean>235||std<15){f.quality='光照或对比度不足';continue;}
   const tensor=this.tensor(this.aligned,true);let result;
   try{result=await this.recognizer.run({[this.recognizer.inputNames[0]]:tensor});f.descriptor=normalize(result[this.recognizer.outputNames[0]].data);if(!f.descriptor)f.quality='特征无效';}finally{tensor.dispose();if(result)Object.values(result).forEach(t=>t.dispose());}
  }
  this.lastMs=performance.now()-started;return faces;
 }
}
