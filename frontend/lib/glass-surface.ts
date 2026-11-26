const linear=(value:number)=>{const c=value/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;};
const srgb=(value:number)=>255*(value<=.0031308?12.92*value:1.055*value**(1/2.4)-.055);
const luminance=(rgb:number[])=>rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;

// Keep every accent on the same transparent surface. Normalizing the tint's
// luminance prevents bright lime from appearing more luminous/transparent.
export function glassSurface(accent:string,dark:boolean) {
  const neutral=(dark?[12,16,23]:[247,250,253]).map(linear);
  const rgb=[1,3,5].map(offset=>linear(parseInt(accent.slice(offset,offset+2),16)));
  const strength=dark?.035:.018,mixed=neutral.map((value,index)=>value*(1-strength)+rgb[index]*strength);
  const scale=luminance(neutral)/Math.max(.00001,luminance(mixed));
  const color=mixed.map(value=>Math.round(Math.min(255,Math.max(0,srgb(value*scale)))));
  return {color,alpha:dark?.18:.28,css:`rgba(${color.join(', ')}, ${dark?.18:.28})`};
}
