export type RGB=[number,number,number];
export function rgb(hex:string):RGB {return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)) as RGB;}
export function hexOf(value:RGB){return '#'+value.map(v=>Math.round(Math.min(255,Math.max(0,v))).toString(16).padStart(2,'0')).join('');}
const luma=(color:RGB)=>color.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
export function contrast(a:RGB,b:RGB){const x=luma(a),y=luma(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
const mix=(a:RGB,b:RGB,p:number)=>a.map((v,i)=>v*(1-p)+b[i]*p) as RGB;
export function normalizeHex(value:string){const text=value.trim();if(/^#[0-9a-f]{6}$/i.test(text))return text.toLowerCase();if(/^#[0-9a-f]{3}$/i.test(text))return '#'+[...text.slice(1)].map(v=>v+v).join('').toLowerCase();return null;}
function readable(color:RGB,dark:boolean){const background:RGB=dark?[12,16,23]:[247,250,253],toward:RGB=dark?[255,255,255]:[0,0,0];if(contrast(color,background)>=4.5)return hexOf(color);let lo=0,hi=1;for(let i=0;i<18;i++){const m=(lo+hi)/2;if(contrast(mix(color,toward,m),background)>=4.6)hi=m;else lo=m;}return hexOf(mix(color,toward,hi));}
export function customColor(hex:string){
 const color=rgb(hex),black:RGB=[0,0,0],white:RGB=[255,255,255];
 const foreground=contrast(color,black)>=contrast(color,white)?black:white;
 let effect=1;
 if(foreground[0]===255){let lo=0,hi=1;for(let i=0;i<18;i++){const m=(lo+hi)/2,p=1-(1-.02*m)*(1-.01*m)*(1-.17*m);if(contrast(mix(color,white,p),foreground)>=4.5)lo=m;else hi=m;}effect=lo;}
 return{color:hex,foreground:hexOf(foreground),lightInk:readable(color,false),darkInk:readable(color,true),effect};
}
export function hsv(hex:string){const [r,g,b]=rgb(hex).map(v=>v/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d)h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;return{h:(h*60+360)%360,s:max?d/max:0,v:max};}
export function fromHsv(h:number,s:number,v:number){const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;const channel=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];return hexOf(channel.map(n=>(n+m)*255) as RGB);}
