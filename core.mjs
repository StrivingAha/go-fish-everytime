export const POSES = ['正脸', '左侧脸', '右侧脸', '低头', '抬头'];
export const MODEL_ID = 'yunet2023-sface-int8-v2';
export const COSINE_THRESHOLD = 0.45;
export function safeUrl(value) {
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('请输入完整的 http 或 https 网站地址');
  return u.href;
}
export function normalize(vector) {
  if(vector?.length!==128 || !Array.from(vector).every(Number.isFinite))return null;
  const norm=Math.hypot(...vector);
  return norm>1e-8?Array.from(vector,x=>x/norm):null;
}
export function cosine(a,b){
  const x=normalize(a),y=normalize(b);
  return x&&y?Math.max(-1,Math.min(1,x.reduce((s,v,i)=>s+v*y[i],0))):-1;
}
// Decision score, not probability. Cosine .45 is the 70-point boundary.
export function decisionScore(c){return c<=COSINE_THRESHOLD?70*Math.max(0,c)/COSINE_THRESHOLD:70+30*(c-COSINE_THRESHOLD)/(1-COSINE_THRESHOLD);}
export function similarity(a,b){return decisionScore(cosine(a,b));}
export function validSamples(samples){return Array.isArray(samples)&&POSES.every(p=>samples.filter(s=>s.model===MODEL_ID&&s.pose===p&&normalize(s.descriptor)).length>=3);}
export function classify(descriptors,samples){
  const valid=samples.filter(s=>s.model===MODEL_ID&&normalize(s.descriptor));
  const cosines=descriptors.map(d=>{const sorted=valid.map(s=>cosine(d,s.descriptor)).sort((a,b)=>b-a);return sorted.length>=2?sorted[1]:-1;});
  return {scores:cosines.map(decisionScore),cosines,stranger:cosines.some(c=>c<COSINE_THRESHOLD),absent:!cosines.some(c=>c>=COSINE_THRESHOLD)};
}
