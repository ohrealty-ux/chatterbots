// Chatter Bots — gorgeous, procedural, data-driven Three.js world. Default HIGH quality.
// Everything procedural (no external model fetch) so it ships reliably from any host.
import * as THREE from '/vendor/three.module.js';
import { EffectComposer } from '/vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from '/vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '/vendor/jsm/postprocessing/UnrealBloomPass.js';

// ───────── deterministic RNG (mulberry32) + value noise ─────────
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
let CFG=null, SEED=1; let RND=mulberry32(1);
function hash2(x,y){ let h=Math.sin(x*127.1+y*311.7+SEED*0.013)*43758.5453; return h-Math.floor(h); }
function noise2(x,y){ const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
  const u=xf*xf*(3-2*xf), v=yf*yf*(3-2*yf);
  const a=hash2(xi,yi),b=hash2(xi+1,yi),c=hash2(xi,yi+1),d=hash2(xi+1,yi+1);
  return a*(1-u)*(1-v)+b*u*(1-v)+c*(1-u)*v+d*u*v; }
function fbm(x,y){ let t=0,amp=0.5,f=1; for(let i=0;i<4;i++){ t+=amp*noise2(x*f,y*f); f*=2; amp*=0.5;} return t; }

// terrain height with carved lake basin + paths
let LAKE={center:[0,0,0],radius:100,depth:6};
function terrainHeight(x,z){
  let h=fbm(x*0.006+10,z*0.006-5)*18 - 6;
  h+=fbm(x*0.02,z*0.02)*3;
  const dx=x-LAKE.center[0], dz=z-LAKE.center[2];
  const d=Math.hypot(dx,dz);
  if(d<LAKE.radius){ const t=d/LAKE.radius; const basin=(1-t*t)*(LAKE.depth+ h+6); h-=basin*1.0; }
  // flatten commons area
  const cdx=x-10, cdz=z-45; const cd=Math.hypot(cdx,cdz);
  if(cd<40){ const t=Math.max(0,1-cd/40); h=h*(1-t)+(0.2)*t; }
  return h;
}

// ───────── globals ─────────
let scene,camera,renderer,composer,bloomPass,sun,sunLight,hemi,clock;
let ws=null, myId=null, myName='Guest';
const remote=new Map();      // id -> {mesh, data, bubbleEl, lastText, plateEl}
const player={ pos:new THREE.Vector3(10,0,58), yaw:Math.PI, pitch:0, vel:new THREE.Vector3(), seated:false };
let quality='high', lowFps=0, frameAvg=16;
const keys={};
let grassMesh,grassCount=0,flowerMesh,treeGroups=[],reedMesh,lilyMesh,waterMesh,birdMesh,butterflyMesh,dragonflyMesh,fishMesh,fireflyMesh,animalMeshes=[],mountains=[];
let audioCtx=null, muted=false, audioStarted=false, audioNodes={};
const tmpV=new THREE.Vector3(), tmpV2=new THREE.Vector3();
const clockDiv=document.getElementById('clock'), qualityDiv=document.getElementById('quality');
let dayPhase=0.34;

// ───────── palette interpolation for time-of-day ─────────
let KF=[];
function cLerp(a,b,t){ return new THREE.Color(a).lerp(new THREE.Color(b),t); }
function todSample(phase){
  const kf=KF; let i=0; for(;i<kf.length-1;i++){ if(phase>=kf[i].t && phase<=kf[i+1].t) break; }
  const A=kf[i], B=kf[Math.min(i+1,kf.length-1)];
  const span=(B.t-A.t)||1; const t=Math.min(1,Math.max(0,(phase-A.t)/span));
  return { sky:cLerp(A.sky,B.sky,t), horizon:cLerp(A.horizon,B.horizon,t), sun:cLerp(A.sun,B.sun,t),
    ambient:cLerp(A.ambient,B.ambient,t), fog:cLerp(A.fog,B.fog,t),
    sunElev:A.sunElev+(B.sunElev-A.sunElev)*t, bloom:A.bloom+(B.bloom-A.bloom)*t, name:(t<0.5?A.name:B.name) };
}

// ───────── init ─────────
async function boot(){
  const res=await fetch('/api/config'); CFG=await res.json();
  SEED=CFG.seed||1; RND=mulberry32(SEED); KF=CFG.timeOfDay.keyframes;
  LAKE={center:CFG.lake.center, radius:CFG.lake.radius, depth:CFG.lake.depth};
  dayPhase=CFG.timeOfDay.startPhase ?? 0.34;
  quality=CFG.quality?.default||'high';
  // Mobile / touch devices default to MEDIUM for a smooth framerate.
  if(isTouch()) quality='medium';
  setupRenderer(); buildWorld();
  if(qualityDiv) qualityDiv.textContent=quality.toUpperCase();
  window.addEventListener('resize',onResize);
  setupInput();
  requestAnimationFrame(loop);
}

function setupRenderer(){
  const canvas=document.getElementById('scene');
  renderer=new THREE.WebGLRenderer({canvas,antialias:quality!=='low',powerPreference:'high-performance'});
  // Cap devicePixelRatio at 1.5 (high) / 1.25 (medium/low) — keeps GPU load sane on retina/mobile.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,quality==='high'?1.5:1.25));
  renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.05;
  scene=new THREE.Scene();
  camera=new THREE.PerspectiveCamera(60,innerWidth/innerHeight,0.1,2200);
  scene.fog=new THREE.Fog(0xcfe0ec,180,1100);
  hemi=new THREE.HemisphereLight(0xffffff,0x3a4a2a,0.6); scene.add(hemi);
  sunLight=new THREE.DirectionalLight(0xffffff,2.2); sunLight.castShadow=true;
  sunLight.shadow.mapSize.set(quality==='high'?2048:1024,quality==='high'?2048:1024);
  sunLight.shadow.camera.near=1; sunLight.shadow.camera.far=600;
  sunLight.shadow.camera.left=-160; sunLight.shadow.camera.right=160;
  sunLight.shadow.camera.top=160; sunLight.shadow.camera.bottom=-160;
  sunLight.shadow.bias=-0.0004; scene.add(sunLight); scene.add(sunLight.target);
  composer=new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene,camera));
  bloomPass=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),0.0,0.5,0.85);
  composer.addPass(bloomPass);
  clock=new THREE.Clock();
}


// ───────── sky dome (gradient shader), stars, moon, clouds ─────────
let skyMat,starField,moon,cloudMesh,sunSprite;
function buildSky(){
  const geo=new THREE.SphereGeometry(1600,32,16);
  skyMat=new THREE.ShaderMaterial({ side:THREE.BackSide, depthWrite:false, uniforms:{
    top:{value:new THREE.Color('#8ec3f0')}, bottom:{value:new THREE.Color('#dff0fb')}, off:{value:0.0} },
    vertexShader:`varying vec3 vp; void main(){ vp=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`varying vec3 vp; uniform vec3 top; uniform vec3 bottom; uniform float off;
      void main(){ float h=normalize(vp).y*0.5+0.5; h=pow(clamp(h+off,0.0,1.0),0.8); gl_FragColor=vec4(mix(bottom,top,h),1.0);}` });
  scene.add(new THREE.Mesh(geo,skyMat));
  // stars
  const sg=new THREE.BufferGeometry(); const N=1400; const pos=new Float32Array(N*3);
  for(let i=0;i<N;i++){ const u=RND(),v=RND(); const th=u*Math.PI*2, ph=Math.acos(2*v-1);
    const r=1500; pos[i*3]=r*Math.sin(ph)*Math.cos(th); pos[i*3+1]=Math.abs(r*Math.cos(ph))*0.9+40; pos[i*3+2]=r*Math.sin(ph)*Math.sin(th); }
  sg.setAttribute('position',new THREE.BufferAttribute(pos,3));
  starField=new THREE.Points(sg,new THREE.PointsMaterial({color:0xffffff,size:3,sizeAttenuation:false,transparent:true,opacity:0}));
  scene.add(starField);
  // moon
  moon=new THREE.Mesh(new THREE.SphereGeometry(28,24,24),new THREE.MeshBasicMaterial({color:0xf4f3e8,fog:false}));
  scene.add(moon);
  // sun sprite (glow)
  const c=document.createElement('canvas'); c.width=c.height=128; const ctx=c.getContext('2d');
  const g=ctx.createRadialGradient(64,64,4,64,64,64); g.addColorStop(0,'rgba(255,245,220,1)'); g.addColorStop(0.3,'rgba(255,210,150,0.7)'); g.addColorStop(1,'rgba(255,180,120,0)');
  ctx.fillStyle=g; ctx.fillRect(0,0,128,128);
  sunSprite=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c),transparent:true,depthWrite:false,fog:false}));
  sunSprite.scale.set(220,220,1); scene.add(sunSprite);
  // drifting clouds (billboard planes)
  const ct=makeCloudTexture();
  cloudMesh=new THREE.Group();
  for(let i=0;i<14;i++){ const m=new THREE.Mesh(new THREE.PlaneGeometry(260+RND()*220,120+RND()*90),
      new THREE.MeshBasicMaterial({map:ct,transparent:true,opacity:0.0,depthWrite:false,fog:false}));
    m.position.set((RND()-0.5)*1800,260+RND()*160,(RND()-0.5)*1800); m.rotation.x=-Math.PI/2.2;
    m.userData.sp=0.4+RND()*0.6; cloudMesh.add(m);} scene.add(cloudMesh);
}
function makeCloudTexture(){ const c=document.createElement('canvas'); c.width=c.height=256; const x=c.getContext('2d');
  for(let i=0;i<40;i++){ const r=20+Math.random()*50; const px=40+Math.random()*180, py=90+Math.random()*80;
    const g=x.createRadialGradient(px,py,0,px,py,r); g.addColorStop(0,'rgba(255,255,255,0.5)'); g.addColorStop(1,'rgba(255,255,255,0)'); x.fillStyle=g; x.beginPath(); x.arc(px,py,r,0,7); x.fill(); }
  return new THREE.CanvasTexture(c); }

// ───────── terrain ─────────
function buildTerrain(){
  const S=CFG.size.groundSize, seg=quality==='high'?220:140;
  const geo=new THREE.PlaneGeometry(S,S,seg,seg); geo.rotateX(-Math.PI/2);
  const pos=geo.attributes.position; const colors=[];
  const cLow=new THREE.Color(CFG.palette.terrainLow), cHigh=new THREE.Color(CFG.palette.terrainHigh), cSand=new THREE.Color(CFG.palette.sand);
  for(let i=0;i<pos.count;i++){ const x=pos.getX(i),z=pos.getZ(i); const h=terrainHeight(x,z); pos.setY(i,h);
    let col; const dxl=x-LAKE.center[0],dzl=z-LAKE.center[2]; const dl=Math.hypot(dxl,dzl);
    if(dl<LAKE.radius+6 && h<0.5){ col=cSand.clone().lerp(cLow,Math.min(1,(h+2)/3)); }
    else { col=cLow.clone().lerp(cHigh,Math.min(1,Math.max(0,(h+6)/22))); }
    colors.push(col.r,col.g,col.b); }
  geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3)); geo.computeVertexNormals();
  const mat=new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.95,metalness:0});
  const ground=new THREE.Mesh(geo,mat); ground.receiveShadow=true; scene.add(ground);
}

// ───────── GPU-instanced wind grass ─────────
const windUniforms={ time:{value:0}, windStr:{value:0.9}, windDir:{value:0.6}, player:{value:new THREE.Vector3()} };
function grassMaterial(base){
  const m=new THREE.MeshStandardMaterial({color:base,roughness:1,metalness:0,side:THREE.DoubleSide});
  m.onBeforeCompile=(sh)=>{ sh.uniforms.time=windUniforms.time; sh.uniforms.windStr=windUniforms.windStr;
    sh.uniforms.windDir=windUniforms.windDir; sh.uniforms.playerPos=windUniforms.player;
    sh.vertexShader='uniform float time; uniform float windStr; uniform float windDir; uniform vec3 playerPos;\n'+
      sh.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        #ifdef USE_INSTANCING
        vec4 wp=instanceMatrix*vec4(0.0,0.0,0.0,1.0);
        float sway=sin(time*1.8 + wp.x*0.3 + wp.z*0.3)*windStr*position.y*0.35;
        transformed.x+=cos(windDir)*sway; transformed.z+=sin(windDir)*sway;
        float pd=distance(wp.xz,playerPos.xz);
        if(pd<2.5){ vec2 away=normalize(wp.xz-playerPos.xz+0.001); transformed.x+=away.x*(2.5-pd)*0.5*position.y; transformed.z+=away.y*(2.5-pd)*0.5*position.y; }
        #endif`); };
  return m;
}
function buildGrass(){
  const want=quality==='high'?Math.min(CFG.densities.grassInstances,30000):quality==='medium'?12000:6000;
  const R=CFG.densities.grassRadius;
  const blade=new THREE.PlaneGeometry(0.12,0.9,1,2); blade.translate(0,0.45,0);
  grassMesh=new THREE.InstancedMesh(blade,grassMaterial(CFG.palette.grassA),want);
  grassMesh.castShadow=false; grassMesh.receiveShadow=false;
  const d=new THREE.Object3D(); let n=0; const cx=10,cz=48;
  for(let i=0;i<want;i++){ const a=RND()*Math.PI*2, r=Math.sqrt(RND())*R;
    const x=cx+Math.cos(a)*r, z=cz+Math.sin(a)*r; const h=terrainHeight(x,z);
    const dl=Math.hypot(x-LAKE.center[0],z-LAKE.center[2]); if(dl<LAKE.radius-2) continue; if(h<0.05) continue;
    d.position.set(x,h,z); d.rotation.y=RND()*Math.PI; const s=0.7+RND()*0.8; d.scale.set(s,s+RND()*0.5,s); d.updateMatrix();
    grassMesh.setMatrixAt(n++,d.matrix); }
  grassMesh.count=n; grassCount=n; grassMesh.instanceMatrix.needsUpdate=true; scene.add(grassMesh);
}
function buildFlowers(){
  const want=quality==='low'?1200:CFG.densities.wildflowerInstances;
  // tiny round flower dots (small spheres — read as round dots from any angle)
  const g=new THREE.SphereGeometry(0.1,7,6); g.translate(0,0.14,0);
  // small, colorful, random mix of pinks / purples / blues / warm accents.
  const colors=['#ec5f9c','#e0579b','#d94fa0','#a06ce0','#8456d8','#6a5ad6','#5a86e0','#4f9be8','#7fc0ef','#f0c04a','#f2f2f2','#ffd24a'];
  flowerMesh=[]; const per=Math.floor(want/colors.length);
  colors.forEach(col=>{ const im=new THREE.InstancedMesh(g,new THREE.MeshStandardMaterial({color:col,emissive:col,emissiveIntensity:0.18,side:THREE.DoubleSide,roughness:1}),per);
    const d=new THREE.Object3D(); let n=0;
    for(let i=0;i<per;i++){ const x=10+(RND()-0.5)*300, z=48+(RND()-0.5)*300;
      const h=terrainHeight(x,z); const dl=Math.hypot(x-LAKE.center[0],z-LAKE.center[2]); if(dl<LAKE.radius||h<0.1) continue;
      const s=0.7+RND()*0.9; d.position.set(x,h,z); d.rotation.y=RND()*6; d.scale.setScalar(s); d.updateMatrix(); im.setMatrixAt(n++,d.matrix); }
    im.count=n; im.instanceMatrix.needsUpdate=true; scene.add(im); flowerMesh.push(im); });
}

// ───────── trees (4 procedural species) + billboarded distant ─────────
function treeMesh(species){
  const g=new THREE.Group();
  const trunkH=[5,7,4,6][species], trunkR=[0.3,0.45,0.25,0.4][species];
  const trunk=new THREE.Mesh(new THREE.CylinderGeometry(trunkR*0.6,trunkR,trunkH,6),new THREE.MeshStandardMaterial({color:'#6b4e2e',roughness:1}));
  trunk.position.y=trunkH/2; trunk.castShadow=true; g.add(trunk);
  const foliCol=['#4f7a3a','#5f8a42','#6f9a4a','#3f6a34'][species];
  const fm=new THREE.MeshStandardMaterial({color:foliCol,roughness:1});
  if(species===2){ // pine
    for(let i=0;i<3;i++){ const c=new THREE.Mesh(new THREE.ConeGeometry(2.4-i*0.6,2.6,7),fm); c.position.y=trunkH-1+i*1.6; c.castShadow=true; g.add(c);} }
  else { const blobs=species===1?4:3; for(let i=0;i<blobs;i++){ const r=1.6+RND()*1.4; const s=new THREE.Mesh(new THREE.IcosahedronGeometry(r,0),fm);
    s.position.set((RND()-0.5)*2.4,trunkH-0.5+RND()*2.2,(RND()-0.5)*2.4); s.castShadow=true; g.add(s);} }
  return g;
}
function buildTrees(){
  const protos=[]; for(let s=0;s<CFG.densities.treeSpecies;s++) protos.push(treeMesh(s));
  const want=quality==='high'?Math.min(CFG.densities.treeInstances,300):quality==='medium'?150:90;
  for(let i=0;i<want;i++){ const a=RND()*Math.PI*2, r=120+RND()*380; const x=10+Math.cos(a)*r, z=48+Math.sin(a)*r;
    if(Math.abs(x)>560||Math.abs(z)>560) continue; const h=terrainHeight(x,z);
    const dl=Math.hypot(x-LAKE.center[0],z-LAKE.center[2]); if(dl<LAKE.radius+6||h<0.2) continue;
    const far=r>240;
    if(far){ // billboard
      const spr=new THREE.Sprite(treeBillboard()); spr.position.set(x,h+4,z); spr.scale.set(9,11,1); scene.add(spr);
    } else { const t=protos[(Math.floor(RND()*protos.length))].clone(); t.position.set(x,h,z); const s=0.7+RND()*0.7; t.scale.setScalar(s); t.rotation.y=RND()*6; scene.add(t); }
  }
}
let _bbTex=null;
function treeBillboard(){ if(!_bbTex){ const c=document.createElement('canvas'); c.width=c.height=64; const x=c.getContext('2d');
  x.fillStyle='#4f7a3a'; x.beginPath(); x.arc(32,24,18,0,7); x.fill(); x.fillRect(29,36,6,22); x.fillStyle='#6b4e2e'; x.fillRect(29,40,6,20);
  _bbTex=new THREE.CanvasTexture(c);} return new THREE.SpriteMaterial({map:_bbTex,transparent:true}); }


// ───────── lake water (scrolling ripples, reflection tint, depth, foam) ─────────
let waterMat;
function buildWater(){
  const geo=new THREE.CircleGeometry(LAKE.radius+2,72); geo.rotateX(-Math.PI/2);
  waterMat=new THREE.ShaderMaterial({transparent:true,uniforms:{
    time:{value:0}, deep:{value:new THREE.Color('#123e46')}, shallow:{value:new THREE.Color(CFG.palette.water)},
    sky:{value:new THREE.Color('#9ec8e8')}, rad:{value:LAKE.radius} },
    vertexShader:`varying vec2 vU; varying float vR; uniform float rad; void main(){ vU=position.xz; vR=length(position.xz)/rad;
      vec3 p=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
    fragmentShader:`varying vec2 vU; varying float vR; uniform float time; uniform vec3 deep; uniform vec3 shallow; uniform vec3 sky;
      void main(){ float r1=sin(vU.x*0.3+time*1.1)+cos(vU.y*0.28-time*0.9); float r2=sin((vU.x+vU.y)*0.18+time*0.7);
        float rip=(r1*0.5+r2)*0.04; vec3 col=mix(shallow,deep,smoothstep(0.2,1.0,vR)); col+=sky*(0.18+rip);
        float foam=smoothstep(0.93,1.0,vR)*(0.6+0.4*sin(vU.x*2.0+time*3.0)); col=mix(col,vec3(0.95),foam*0.7);
        // ── always-on sun sparkles: sharp twinkling specular glints dancing on the surface ──
        float s1=pow(max(0.0,sin(vU.x*3.1+time*2.0)*cos(vU.y*2.7-time*1.7)),42.0);
        float s2=pow(max(0.0,sin(vU.x*1.7-time*1.3)*cos(vU.y*2.1+time*1.1)),64.0);
        float s3=pow(max(0.0,sin((vU.x-vU.y)*4.3+time*2.6)),80.0);
        float sparkle=(s1+s2*1.3+s3*0.9)*(1.0-smoothstep(0.85,1.0,vR));
        col+=vec3(1.0,0.96,0.82)*sparkle*1.6;
        gl_FragColor=vec4(col,0.86);}` });
  waterMesh=new THREE.Mesh(geo,waterMat); waterMesh.position.set(LAKE.center[0],-0.3,LAKE.center[2]); scene.add(waterMesh);
  // reeds + lily pads
  const reedG=new THREE.CylinderGeometry(0.04,0.06,1.6,4); reedG.translate(0,0.8,0);
  reedMesh=new THREE.InstancedMesh(reedG,new THREE.MeshStandardMaterial({color:'#5c7a3a'}),CFG.densities.reedInstances);
  const d=new THREE.Object3D(); let n=0;
  for(let i=0;i<CFG.densities.reedInstances;i++){ const a=RND()*6.283, r=LAKE.radius-1-RND()*5;
    const x=LAKE.center[0]+Math.cos(a)*r,z=LAKE.center[2]+Math.sin(a)*r; d.position.set(x,0,z); d.rotation.y=RND()*6; d.scale.setScalar(0.6+RND()*0.8); d.updateMatrix(); reedMesh.setMatrixAt(n++,d.matrix);} 
  reedMesh.count=n; reedMesh.instanceMatrix.needsUpdate=true; scene.add(reedMesh);
  const padG=new THREE.CircleGeometry(0.6,8); padG.rotateX(-Math.PI/2);
  lilyMesh=new THREE.InstancedMesh(padG,new THREE.MeshStandardMaterial({color:'#3f6a34',side:THREE.DoubleSide}),CFG.densities.lilyPadInstances);
  let m=0; for(let i=0;i<CFG.densities.lilyPadInstances;i++){ const a=RND()*6.283,r=RND()*(LAKE.radius-10);
    const x=LAKE.center[0]+Math.cos(a)*r,z=LAKE.center[2]+Math.sin(a)*r; d.position.set(x,-0.2,z); d.rotation.y=RND()*6; d.scale.setScalar(0.7+RND()); d.updateMatrix(); lilyMesh.setMatrixAt(m++,d.matrix);} 
  lilyMesh.count=m; lilyMesh.instanceMatrix.needsUpdate=true; scene.add(lilyMesh);
}

// ───────── cheap life ─────────
const life={birds:[],butterflies:[],dragonflies:[],fish:[],fireflies:[],animals:[],waterfowl:[]};
function buildLife(){
  // birds (flocking-ish instanced cones)
  const bg=new THREE.ConeGeometry(0.3,1.2,4); bg.rotateX(Math.PI/2);
  birdMesh=new THREE.InstancedMesh(bg,new THREE.MeshStandardMaterial({color:'#2a2a2a'}),CFG.densities.birds);
  for(let i=0;i<CFG.densities.birds;i++) life.birds.push({a:RND()*6.283,r:60+RND()*220,y:60+RND()*60,sp:0.2+RND()*0.4});
  scene.add(birdMesh);
  // butterflies — lush, bright, per-instance colour, gentle glow
  const btPal=['#ff4fa3','#39d3ff','#ffd21f','#b45cff','#ff8a2b','#8aff5a','#ff5a4f','#4fffd0','#ff6fe0','#7cc0ff'];
  const btg=new THREE.PlaneGeometry(0.5,0.38);
  butterflyMesh=new THREE.InstancedMesh(btg,new THREE.MeshStandardMaterial({side:THREE.DoubleSide,transparent:true,emissive:'#ffffff',emissiveIntensity:0.18,roughness:0.5}),CFG.densities.butterflies);
  const _bc=new THREE.Color();
  for(let i=0;i<CFG.densities.butterflies;i++){ life.butterflies.push({x:10+(RND()-0.5)*220,z:48+(RND()-0.5)*220,ph:RND()*6,sc:0.8+RND()*0.8}); butterflyMesh.setColorAt(i,_bc.set(btPal[i%btPal.length])); }
  if(butterflyMesh.instanceColor) butterflyMesh.instanceColor.needsUpdate=true;
  scene.add(butterflyMesh);
  // dragonflies — slender iridescent bodies with shimmering wings, hover over water & reeds
  const dfPal=['#35e0c8','#49b0ff','#7cf05a','#ffcf3a','#ff7ad0'];
  const dfg=new THREE.PlaneGeometry(0.9,0.42);
  dragonflyMesh=new THREE.InstancedMesh(dfg,new THREE.MeshStandardMaterial({side:THREE.DoubleSide,transparent:true,opacity:0.92,emissive:'#bfffe8',emissiveIntensity:0.3,metalness:0.4,roughness:0.3}),CFG.densities.dragonflies);
  for(let i=0;i<CFG.densities.dragonflies;i++){
    const nearWater=RND()<0.7; let x,z;
    if(nearWater){ const a=RND()*6.283, r=(LAKE.radius-2)-RND()*20; x=LAKE.center[0]+Math.cos(a)*r; z=LAKE.center[2]+Math.sin(a)*r; }
    else { x=10+(RND()-0.5)*180; z=48+(RND()-0.5)*180; }
    life.dragonflies.push({bx:x,bz:z,ph:RND()*6,sp:0.7+RND()*0.9,rad:1.5+RND()*3});
    dragonflyMesh.setColorAt(i,_bc.set(dfPal[i%dfPal.length]));
  }
  if(dragonflyMesh.instanceColor) dragonflyMesh.instanceColor.needsUpdate=true;
  scene.add(dragonflyMesh);
  // fish (in lake, under surface)
  const fg=new THREE.ConeGeometry(0.2,0.8,4); fg.rotateX(Math.PI/2);
  fishMesh=new THREE.InstancedMesh(fg,new THREE.MeshStandardMaterial({color:'#8899aa'}),CFG.densities.fish);
  for(let i=0;i<CFG.densities.fish;i++) life.fish.push({a:RND()*6.283,r:RND()*(LAKE.radius-14),sp:0.3+RND()*0.5});
  scene.add(fishMesh);
  // fireflies (points, night only)
  const fg2=new THREE.BufferGeometry(); const fpos=new Float32Array(CFG.densities.fireflies*3);
  for(let i=0;i<CFG.densities.fireflies;i++){ const x=10+(RND()-0.5)*160,z=48+(RND()-0.5)*160; fpos[i*3]=x; fpos[i*3+1]=1+RND()*3; fpos[i*3+2]=z; life.fireflies.push({bx:x,bz:fpos[i*3+2],ph:RND()*6}); }
  fg2.setAttribute('position',new THREE.BufferAttribute(fpos,3));
  fireflyMesh=new THREE.Points(fg2,new THREE.PointsMaterial({color:0xffe08a,size:0.22,transparent:true,opacity:0})); scene.add(fireflyMesh);
  // ground animals (deer/rabbit) — simple low-poly bodies that wander
  for(let i=0;i<CFG.densities.groundAnimals;i++){ const g=new THREE.Group();
    const body=new THREE.Mesh(new THREE.CapsuleGeometry(0.4,1.0,4,6),new THREE.MeshStandardMaterial({color:i%2?'#c9a06a':'#b98d5a'})); body.rotation.z=Math.PI/2; body.position.y=1; body.castShadow=true; g.add(body);
    const head=new THREE.Mesh(new THREE.SphereGeometry(0.3,8,8),body.material); head.position.set(0.8,1.4,0); g.add(head);
    g.position.set(10+(RND()-0.5)*160,0,48+(RND()-0.5)*160); scene.add(g);
    life.animals.push({g,tx:g.position.x,tz:g.position.z,t:0}); }
  buildWaterfowl();
}
// ───────── ducks & geese: procedural waterfowl drifting on the lake ─────────
function buildWaterfowl(){
  const WL=-0.3; // water surface y
  const n=CFG.densities.waterfowl||0;
  for(let i=0;i<n;i++){
    const goose=RND()<0.4; const g=new THREE.Group();
    const bodyCol = goose ? (RND()<0.5?'#c9c7bf':'#8d8a80') : (i%3===0?'#3a6f4a':'#7a5a38');
    const bodyMat=new THREE.MeshStandardMaterial({color:bodyCol,roughness:0.85});
    const neckMat=new THREE.MeshStandardMaterial({color:goose?'#2b2b2b':(i%3===0?'#15502f':'#5a4228'),roughness:0.8});
    const scl=goose?1.35:0.95;
    // body (ellipsoid) sitting low in the water
    const body=new THREE.Mesh(new THREE.SphereGeometry(0.6,12,10),bodyMat); body.scale.set(1.5,0.8,0.9); body.position.set(0,WL+0.28*scl,0); body.castShadow=true; g.add(body);
    // tail tip
    const tail=new THREE.Mesh(new THREE.ConeGeometry(0.22,0.6,6),bodyMat); tail.rotation.z=Math.PI/2; tail.position.set(-0.95*1.0,WL+0.42*scl,0); g.add(tail);
    // neck (curved — two segments) + head + bill, facing +X
    const neck=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.17,goose?1.0:0.55,8),neckMat); neck.position.set(0.7,WL+(goose?0.78:0.58)*scl,0); neck.rotation.z=-0.5; g.add(neck);
    const head=new THREE.Mesh(new THREE.SphereGeometry(goose?0.2:0.22,12,10),neckMat); head.position.set(goose?1.05:0.92,WL+(goose?1.18:0.82)*scl,0); g.add(head);
    const billCol = goose ? '#1c1c1c' : (i%3===0?'#2d2d2d':'#e8a23a');
    const bill=new THREE.Mesh(new THREE.ConeGeometry(0.08,0.3,6),new THREE.MeshStandardMaterial({color:billCol,roughness:0.6})); bill.rotation.z=-Math.PI/2; bill.position.set((goose?1.28:1.16),WL+(goose?1.14:0.78)*scl,0); g.add(bill);
    g.scale.setScalar(scl);
    // place within lake, away from the very centre & edges
    const a=RND()*6.283, r=12+RND()*(LAKE.radius-28);
    g.position.set(LAKE.center[0]+Math.cos(a)*r, 0, LAKE.center[2]+Math.sin(a)*r);
    g.rotation.y=RND()*6.283; scene.add(g);
    life.waterfowl.push({g,a:RND()*6.283,r,sp:0.05+RND()*0.09,ph:RND()*6,wob:0.4+RND()*0.6});
  }
}

// ───────── mountains / horizon silhouettes ─────────
function buildMountains(){
  for(let ring=0;ring<CFG.densities.mountainRings;ring++){ const R=900+ring*180; const seg=48;
    const pts=[]; for(let i=0;i<=seg;i++){ const a=i/seg*Math.PI*2; const hh=60+fbm(Math.cos(a)*4+ring*3,Math.sin(a)*4)*180;
      pts.push(new THREE.Vector3(Math.cos(a)*R,0,Math.sin(a)*R)); pts.push(new THREE.Vector3(Math.cos(a)*R,hh,Math.sin(a)*R)); }
    const g=new THREE.BufferGeometry().setFromPoints(pts);
    const idx=[]; for(let i=0;i<seg;i++){ const b=i*2; idx.push(b,b+1,b+2, b+1,b+3,b+2);} g.setIndex(idx); g.computeVertexNormals();
    const col=ring===0?'#5a6a86':'#6a7a96';
    const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:col,fog:true,side:THREE.DoubleSide})); scene.add(m); mountains.push(m); }
}

// ───────── commons props: a single lakeside meeting bench + stone path ─────────
const seatMarkers=new Map(); // slotId -> {pos, mesh}
function buildCommons(){
  const C=CFG.commons;
  // The single lakeside meeting bench — beside the dock, on the shore, facing the water.
  buildMeetingBench(C);
  // a nice stone path winding from the spawn clearing down to the dock/shore (kept open, not blocked)
  (function(){ const stone=new THREE.MeshStandardMaterial({color:'#9a9aa0',roughness:0.98}),
                     stoneDk=new THREE.MeshStandardMaterial({color:'#83838a',roughness:0.98});
    const from=[10.5,56.5], to=[9,40.5], steps=18;
    for(let i=0;i<=steps;i++){ const t=i/steps;
      const x=from[0]+(to[0]-from[0])*t + (noise2(i*0.8,3.1)-0.5)*1.6;
      const z=from[1]+(to[1]-from[1])*t;
      const h=terrainHeight(x,z); if(h<0.1) continue;
      const r=0.5+RND()*0.28;
      const st=new THREE.Mesh(new THREE.CylinderGeometry(r,r,0.1,7), i%2?stone:stoneDk);
      st.position.set(x,h+0.04,z); st.rotation.y=RND()*6; st.scale.set(1,1,0.8+RND()*0.4); st.receiveShadow=true; scene.add(st); } })();
}

// A single, well-proportioned wooden bench: seat + backrest + legs + a soft contact shadow.
// Long axis runs east–west (parallel to the shore); seats face local -z (toward the lake).
// Each seat half is clickable and registers into seatMarkers so visitors can click to sit — no gold ring.
function buildMeetingBench(C){
  const lb=(C.seatAnchors||[]).find(s=>s.id==='lakeside-bench'); if(!lb) return;
  const [cx,,cz]=lb.center; const gh=terrainHeight(cx,cz);
  const wood=new THREE.MeshStandardMaterial({color:'#9a7342',roughness:0.8});
  const woodDk=new THREE.MeshStandardMaterial({color:'#7a5730',roughness:0.88});
  const g=new THREE.Group(); g.position.set(cx,gh,cz); g.rotation.y=(lb.facing||0); scene.add(g);
  const LEN=3.0, DEPTH=0.6, SEATY=0.5;
  // soft contact shadow (flattened translucent disc under the bench)
  const shadow=new THREE.Mesh(new THREE.CircleGeometry(1.9,28), new THREE.MeshBasicMaterial({color:0x100d06,transparent:true,opacity:0.26,depthWrite:false}));
  shadow.rotation.x=-Math.PI/2; shadow.position.set(0,0.03,0.05); shadow.scale.set(1,0.6,1); g.add(shadow);
  // two seat halves (each clickable → its own slot id)
  lb.slots.forEach((sl,idx)=>{ const side=(idx===0?-1:1);
    const half=new THREE.Mesh(new THREE.BoxGeometry(LEN/2-0.04,0.12,DEPTH),wood);
    half.position.set(side*(LEN/4+0.01),SEATY,0); half.castShadow=true; half.receiveShadow=true;
    half.userData.seatId=sl.id; g.add(half);
    seatMarkers.set(sl.id,{pos:[cx+side*(LEN/4),gh+SEATY,cz],mesh:half}); });
  // backrest: two horizontal rails on the +z (back) edge, behind the sitter
  const bz=DEPTH/2-0.05;
  [SEATY+0.5,SEATY+0.24].forEach(y=>{ const rail=new THREE.Mesh(new THREE.BoxGeometry(LEN,0.1,0.08),wood); rail.position.set(0,y,bz); rail.castShadow=true; g.add(rail); });
  [-1,1].forEach(s=>{ const post=new THREE.Mesh(new THREE.BoxGeometry(0.1,0.72,0.1),woodDk); post.position.set(s*(LEN/2-0.1),SEATY+0.3,bz); post.castShadow=true; g.add(post); });
  // front apron under the seat lip
  const apron=new THREE.Mesh(new THREE.BoxGeometry(LEN,0.1,0.06),woodDk); apron.position.set(0,SEATY-0.1,-DEPTH/2+0.07); g.add(apron);
  // four sturdy legs
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx,sz])=>{ const leg=new THREE.Mesh(new THREE.BoxGeometry(0.12,SEATY,0.12),woodDk);
    leg.position.set(sx*(LEN/2-0.2),SEATY/2-0.02,sz*(DEPTH/2-0.1)); leg.castShadow=true; g.add(leg); });
}
// ───────── wooden meeting dock: extends over the water, beside the shore bench ─────────
function buildDock(){
  const wood=new THREE.MeshStandardMaterial({color:'#9a7342',roughness:0.85});
  const woodDark=new THREE.MeshStandardMaterial({color:'#7d5a30',roughness:0.9});
  const anchor=[8,38.6];                      // dock root on the shore
  const cx=LAKE.center[0], cz=LAKE.center[2];
  let dx=cx-anchor[0], dz=cz-anchor[1]; const dl=Math.hypot(dx,dz); dx/=dl; dz/=dl;   // toward water
  const px=-dz, pz=dx;                          // perpendicular (deck width axis)
  const yaw=Math.atan2(-dz,dx);                // align box local +X with (dx,dz)
  const LEN=17, WID=2.8, DECK_Y=0.5;
  const mid=[anchor[0]+dx*(LEN/2), anchor[1]+dz*(LEN/2)];
  // main deck slab
  const deck=new THREE.Mesh(new THREE.BoxGeometry(LEN,0.16,WID),wood); deck.position.set(mid[0],DECK_Y,mid[1]); deck.rotation.y=yaw; deck.receiveShadow=true; deck.castShadow=true; scene.add(deck);
  // cross-planks for texture (alternating tone)
  const planks=Math.floor(LEN/0.6);
  for(let i=0;i<planks;i++){ const d=(i+0.5)*0.6 - 0.1; const bx=anchor[0]+dx*d, bz=anchor[1]+dz*d;
    const pl=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.05,WID-0.08), i%2?woodDark:wood); pl.position.set(bx,DECK_Y+0.11,bz); pl.rotation.y=yaw; scene.add(pl); }
  // pilings into the water + railing posts above
  for(let i=0;i<=4;i++){ const d=i/4*LEN; for(const side of [-1,1]){
    const bx=anchor[0]+dx*d+px*(WID/2-0.2)*side, bz=anchor[1]+dz*d+pz*(WID/2-0.2)*side;
    const pile=new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.18,3.4,8),woodDark); pile.position.set(bx,-1.05,bz); pile.castShadow=true; scene.add(pile);
    if(i>0){ const post=new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.08,0.95,6),wood); post.position.set(bx,DECK_Y+0.5,bz); scene.add(post); } } }
  // top rails along both sides
  for(const side of [-1,1]){ const sx=anchor[0]+px*(WID/2-0.2)*side, sz=anchor[1]+pz*(WID/2-0.2)*side;
    const rail=new THREE.Mesh(new THREE.BoxGeometry(LEN-1,0.1,0.1),wood); rail.position.set(sx+dx*(LEN/2), DECK_Y+0.95, sz+dz*(LEN/2)); rail.rotation.y=yaw; scene.add(rail); }
  // a shade tree beside the dock root
  const tb=anchor[0]+px*3.4, tbz=anchor[1]+pz*3.4;
  if(terrainHeight(tb,tbz)>0.1){ const tg=treeMesh(1); tg.position.set(tb,terrainHeight(tb,tbz),tbz); tg.scale.setScalar(1.25); scene.add(tg); }
}

// ───────── Beacon Studio kiosk: a small signpost near the lakeside bench ─────────
// Clicking (or walking up and clicking) it opens the Beacon Studio panel. Purely a UI entry
// point — no beacon data lives here. Registered meshes are raycast in handlePick().
const studioMarkers=[];
function beaconSignTexture(){
  const c=document.createElement('canvas'); c.width=256; c.height=160; const x=c.getContext('2d');
  const grad=x.createLinearGradient(0,0,0,160); grad.addColorStop(0,'#1b2231'); grad.addColorStop(1,'#10151f');
  x.fillStyle=grad; x.fillRect(0,0,256,160);
  x.strokeStyle='#D4AF37'; x.lineWidth=5; x.strokeRect(5,5,246,150);
  x.textAlign='center'; x.fillStyle='#f3d473'; x.font='bold 38px system-ui,Arial'; x.fillText('🛰 Beacon', 128, 58);
  x.fillStyle='#ffffff'; x.font='bold 34px system-ui,Arial'; x.fillText('Studio', 128, 98);
  x.fillStyle='#c7cad3'; x.font='500 18px system-ui,Arial'; x.fillText('tap to open', 128, 132);
  const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; return t;
}
function buildBeaconStudio(){
  const bx=21, bz=43;                         // just east of the bench, on the shore clearing
  const gh=terrainHeight(bx,bz); if(gh<0.1) return;
  const g=new THREE.Group(); g.position.set(bx,gh,bz); scene.add(g);
  const woodDk=new THREE.MeshStandardMaterial({color:'#7a5730',roughness:0.9});
  // post
  const post=new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.1,2.0,8),woodDk); post.position.y=1.0; post.castShadow=true; g.add(post);
  // sign board (double-sided, faces the bench/path)
  const board=new THREE.Mesh(new THREE.BoxGeometry(1.7,1.06,0.08),
    new THREE.MeshStandardMaterial({map:beaconSignTexture(),emissive:0x1a1710,emissiveIntensity:0.35,roughness:0.6}));
  board.position.y=2.1; board.rotation.y=Math.PI*0.12; board.castShadow=true; g.add(board);
  board.userData.studio=true; studioMarkers.push(board);
  // a soft glowing orb atop the post (echoes the beacon badge)
  const orb=new THREE.Mesh(new THREE.SphereGeometry(0.14,12,12),
    new THREE.MeshStandardMaterial({color:0xf3d473,emissive:0xf3d473,emissiveIntensity:1.4})); orb.position.y=2.78; g.add(orb);
  studioMarkers.push(orb); orb.userData.studio=true; g.userData.studioOrb=orb;
}

// ───────── avatars ─────────
const _avTexCache=new Map();
function avatarMesh(data){
  const g=new THREE.Group();
  const isBot=data.kind==='bot';
  const bodyCol=isBot?0xD4AF37:(0x4a7ac0+((hashStr(data.id)%0x303030)));
  const body=new THREE.Mesh(new THREE.CapsuleGeometry(0.35,0.9,4,8),new THREE.MeshStandardMaterial({color:bodyCol,roughness:0.7}));
  body.position.y=1.0; body.castShadow=true; g.add(body);
  const head=new THREE.Mesh(new THREE.SphereGeometry(0.32,16,16),new THREE.MeshStandardMaterial({color:0xf0cba0,roughness:0.6}));
  head.position.y=1.85; head.castShadow=true; g.add(head);
  // avatar face billboard (e.g. Elowen)
  if(data.avatar){ const tex=loadTex(data.avatar); const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true})); spr.scale.set(1.1,1.1,1); spr.position.y=1.9; g.add(spr); head.visible=false; }
  if(isBot){ // status lantern above head
    const lan=new THREE.Mesh(new THREE.SphereGeometry(0.12,8,8),new THREE.MeshStandardMaterial({color:0x9aa0ad,emissive:0x333333,emissiveIntensity:1})); lan.position.y=2.4; g.add(lan); g.userData.lantern=lan; }
  g.userData.data=data; g.userData.body=body;
  return g;
}
function loadTex(url){ if(_avTexCache.has(url)) return _avTexCache.get(url); const t=new THREE.TextureLoader().load(url); t.colorSpace=THREE.SRGBColorSpace; _avTexCache.set(url,t); return t; }
function hashStr(s){ let h=0; for(let i=0;i<(s||'').length;i++) h=(h*31+s.charCodeAt(i))|0; return Math.abs(h); }

function buildWorld(){
  buildSky(); buildMountains(); buildTerrain(); buildWater(); buildGrass(); buildFlowers(); buildTrees(); buildLife(); buildCommons(); buildDock(); buildBeaconStudio();
  updateTOD(dayPhase);
}

// ───────── nameplates / bubbles (HTML overlay, textContent only — never innerHTML) ─────────
const platesRoot=document.getElementById('nameplates');
function ensurePlate(id,data){
  let e=remote.get(id); if(e&&e.plate) return e;
  const plate=document.createElement('div'); plate.className='plate'+(data.kind==='bot'?' bot':'');
  const nm=document.createElement('span'); nm.className='nm'; nm.textContent=data.name; plate.appendChild(nm);
  if(data.kind==='bot'){ const tag=document.createElement('span'); tag.className='tag'; tag.textContent='BOT'; nm.appendChild(tag);
    // decorative "has a beacon" badge (cosmetic glow only — no real beacon data)
    if(data.beacon){ const bdg=document.createElement('span'); bdg.className='beacon-badge'; bdg.title='Has a Bot Beacon'; nm.appendChild(bdg); }
    const owner=document.createElement('span'); owner.className='owner'; owner.textContent='by '+(data.owner||'Chatter Bots'); plate.appendChild(owner); }
  const st=document.createElement('span'); st.className='status st-'+(data.status||'idle'); st.textContent=''; plate.appendChild(st);
  const bubble=document.createElement('span'); bubble.className='bubble'; bubble.style.display='none'; plate.appendChild(bubble);
  platesRoot.appendChild(plate);
  if(!e){ e={}; remote.set(id,e); } e.plate=plate; e.nm=nm; e.st=st; e.bubble=bubble; return e;
}
function showBubble(id,text){ const e=remote.get(id); if(!e||!e.bubble) return; e.bubble.textContent=text; e.bubble.style.display='block';
  clearTimeout(e.bubbleT); e.bubbleT=setTimeout(()=>{ if(e.bubble) e.bubble.style.display='none'; },6000); }

// ───────── networking ─────────
function connect(){
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(`${proto}://${location.host}/world/v1/ws?name=${encodeURIComponent(myName)}`);
  ws.onopen=()=>console.log('[ws] connected');
  ws.onclose=()=>{ setTimeout(connect,2000); };
  ws.onmessage=(ev)=>{ let m; try{m=JSON.parse(ev.data);}catch{return;}
    if(m.type==='welcome'){ myId=m.you; }
    else if(m.type==='state'){ applyState(m.snap); }
    else if(m.type==='chat'){ onChat(m.msg); }
    else if(m.type==='history'){ (m.messages||[]).forEach(x=>addChatLine(x.actor,x.actor_kind,x.text)); }
  };
}
function applyState(snap){
  const seen=new Set();
  for(const ed of snap.entities){ seen.add(ed.id);
    if(ed.id===myId){ // reconcile seat
      player.seated=!!ed.seat; if(ed.seat){ player.pos.set(ed.pos[0],0,ed.pos[2]); player.yaw=ed.yaw; } continue; }
    let e=remote.get(ed.id);
    if(!e||!e.mesh){ const mesh=avatarMesh(ed); scene.add(mesh); e=ensurePlate(ed.id,ed); e.mesh=mesh; e.data=ed; remote.set(ed.id,e); }
    e.target={x:ed.pos[0],z:ed.pos[2],yaw:ed.yaw}; e.data=ed;
    if(e.st) e.st.textContent=ed.kind==='bot'?(ed.status||''):''; if(e.st) e.st.className='status st-'+(ed.status||'idle');
    if(e.mesh&&e.mesh.userData.lantern){ const c={idle:0x9aa0ad,working:0x6fc0ff,done:0x7ddf8f,needs_attention:0xffb24a}[ed.status||'idle'];
      e.mesh.userData.lantern.material.color.setHex(c); e.mesh.userData.lantern.material.emissive.setHex(c); }
  }
  for(const [id,e] of remote){ if(!seen.has(id)){ if(e.mesh) scene.remove(e.mesh); if(e.plate) e.plate.remove(); remote.delete(id); } }
}
function onChat(msg){ addChatLine(msg.name,msg.kind,msg.text); if(msg.id!==myId) showBubble(msg.id,msg.text); }
function addChatLine(name,kind,text){ const log=document.getElementById('chatlog'); const d=document.createElement('div');
  d.className='line'+(kind==='bot'?' bot':''); const n=document.createElement('span'); n.className='nm'; n.textContent=name+': ';
  const t=document.createElement('span'); t.textContent=text; d.appendChild(n); d.appendChild(t); log.appendChild(d);
  while(log.children.length>60) log.removeChild(log.firstChild); log.scrollTop=log.scrollHeight; }

// ───────── input / controls ─────────
let yawVel=0,pitchVel=0,pointerLocked=false,touchMove={x:0,y:0};
function setupInput(){
  addEventListener('keydown',e=>{ keys[e.code]=true; if(e.code==='Space'&&player.seated) sendStand(); });
  addEventListener('keyup',e=>{ keys[e.code]=false; });
  const canvas=document.getElementById('scene');
  canvas.addEventListener('click',(e)=>{ startAudio(); if(!pointerLocked && !isTouch()){ canvas.requestPointerLock?.(); } handlePick(e); });
  document.addEventListener('pointerlockchange',()=>{ pointerLocked=document.pointerLockElement===canvas; });
  addEventListener('mousemove',e=>{ if(pointerLocked){ player.yaw-=e.movementX*0.0025; player.pitch=Math.max(-1.2,Math.min(0.6,player.pitch-e.movementY*0.0025)); } });
  // chat
  const cf=document.getElementById('chatform'); cf.addEventListener('submit',e=>{ e.preventDefault(); const i=document.getElementById('chatinput');
    const t=i.value.trim(); if(t&&ws&&ws.readyState===1){ ws.send(JSON.stringify({type:'say',text:t})); } i.value=''; i.blur(); });
  document.getElementById('muteBtn').addEventListener('click',toggleMute);
  document.getElementById('helpBtn').addEventListener('click',()=>alert('WASD/arrows move · drag mouse (click to lock) to look · click the bench to sit · Space to stand · click a bot to greet · type to chat with people nearby. Phones: use the stick + drag to look.'));
  // touch look + joystick
  if(isTouch()){ document.getElementById('stick').classList.remove('hidden'); setupTouch(); }
  // join
  document.getElementById('enterBtn').addEventListener('click',enter);
  document.getElementById('guestname').addEventListener('keydown',e=>{ if(e.key==='Enter') enter(); });
  // NOTE: setupInvite() is wired EARLY (at module load), not here — see bottom of file —
  // so the join-card buttons (Beacon Studio, quick actions, share) respond immediately,
  // before the heavy 3D world finishes building.
}

// ───────── invite / share: open a meeting-prep page, four simple actions ─────────
// The share link now points at the /meet prep page (Will your bot meet my bot?) so both
// parties can fill in goals/agenda before their bots meet at the lakeside bench. A meeting
// is created on demand the first time the owner shares, then cached for the session.
let _meetId=null, _meetPending=null;
async function ensureMeeting(){
  if(_meetId) return _meetId;
  if(_meetPending) return _meetPending;
  _meetPending=(async()=>{
    try{
      const r=await fetch('/api/meet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'lakeside bench'})});
      const j=await r.json();
      if(j&&j.id){ _meetId=j.id; return _meetId; }
    }catch{}
    return null;
  })();
  const id=await _meetPending; _meetPending=null; return id;
}
function meetUrlFor(id){ return location.origin+'/meet?m='+encodeURIComponent(id); }
function inviteText(link){ return 'Meet my bot at Chatter Bots (lakeside bench) — '+link+'. Prepare your bot with the discussion points.'; }
function setShareStatus(msg){ ['shareStatus','shareStatus2'].forEach(id=>{ const el=document.getElementById(id); if(el){ el.textContent=msg; clearTimeout(el._t); el._t=setTimeout(()=>{ if(el) el.textContent=''; },2600); } }); }
async function doShare(action){
  setShareStatus('Creating meeting…');
  const id=await ensureMeeting();
  const link = id ? meetUrlFor(id) : (location.origin+'/meet');
  const msg=inviteText(link);
  if(action==='copy'){
    try{ await navigator.clipboard.writeText(link); setShareStatus('Link copied ✓'); }
    catch{ try{ const t=document.createElement('textarea'); t.value=link; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); setShareStatus('Link copied ✓'); }
           catch{ setShareStatus('Copy failed — '+link); } }
  } else if(action==='x'){
    window.open('https://twitter.com/intent/tweet?text='+encodeURIComponent(msg),'_blank','noopener');
  } else if(action==='email'){
    window.location.href='mailto:?subject='+encodeURIComponent('Meet my bot at Chatter Bots')+'&body='+encodeURIComponent(msg);
  } else if(action==='sms'){
    window.location.href='sms:?&body='+encodeURIComponent(msg);
  }
}
function setupInvite(){
  document.querySelectorAll('.share-btn').forEach(b=>b.addEventListener('click',()=>doShare(b.dataset.share)));
  // "Start meeting prep" CTAs: create a meeting id, then open the /meet intake page for it
  ['intakeCta','intakeCta2'].forEach(id=>{ const c=document.getElementById(id); if(c) c.addEventListener('click',async e=>{
    e.preventDefault(); setShareStatus('Opening meeting prep…');
    const mid=await ensureMeeting(); window.location.href = mid ? meetUrlFor(mid) : (location.origin+'/meet'); }); });
  const modal=document.getElementById('invitemodal');
  const ib=document.getElementById('inviteBtn'); if(ib) ib.addEventListener('click',()=>modal&&modal.classList.remove('hidden'));
  const ic=document.getElementById('inviteClose'); if(ic) ic.addEventListener('click',()=>modal&&modal.classList.add('hidden'));
  if(modal) modal.addEventListener('click',e=>{ if(e.target===modal) modal.classList.add('hidden'); });
  // Beacon Studio: every "Get your Bot Beacon" entry point opens the same panel.
  const bm=document.getElementById('beaconModal');
  const bp=document.getElementById('beaconPlug'); if(bp) bp.addEventListener('click',openBeaconStudio);
  const qb=document.getElementById('qaBeacon'); if(qb) qb.addEventListener('click',openBeaconStudio);
  const bc=document.getElementById('beaconClose'); if(bc) bc.addEventListener('click',closeBeaconStudio);
  if(bm) bm.addEventListener('click',e=>{ if(e.target===bm) closeBeaconStudio(); });
  // Copy buttons: copy the exact message (from data-copy) for the user's Grok bot.
  const wireCopy=(id)=>{ const cp=document.getElementById(id); if(!cp) return; cp.addEventListener('click',()=>{
    const txt=cp.getAttribute('data-copy')||''; const note=document.getElementById('beaconCopied');
    const done=()=>{ if(note){ note.textContent='Copied ✓ — paste it into your Grok Bot app'; clearTimeout(note._t); note._t=setTimeout(()=>{ note.textContent=''; },3200);} };
    (navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject())
      .then(done).catch(()=>{ try{ const t=document.createElement('textarea'); t.value=txt; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done(); }catch{ if(note) note.textContent='Copy failed — select the message manually.'; } });
  }); };
  wireCopy('beaconCopy'); wireCopy('beaconCopyJoin');
  // quick-action buttons on the join card
  const qm=document.getElementById('qaMeet'); if(qm) qm.addEventListener('click',async e=>{ e.preventDefault(); const mid=await ensureMeeting(); window.location.href=mid?meetUrlFor(mid):(location.origin+'/meet'); });
  const qe=document.getElementById('qaEnter'); if(qe) qe.addEventListener('click',()=>{ const gn=document.getElementById('guestname'); if(gn) gn.focus(); });
}
function openBeaconStudio(){ const bm=document.getElementById('beaconModal'); if(bm) bm.classList.remove('hidden'); }
function closeBeaconStudio(){ const bm=document.getElementById('beaconModal'); if(bm) bm.classList.add('hidden'); }
function isTouch(){ return matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window; }
function enter(){ myName=(document.getElementById('guestname').value||'Guest').slice(0,24)||'Guest';
  document.getElementById('join').classList.add('hidden'); document.getElementById('hud').classList.remove('hidden');
  startAudio(); connect(); }
function setupTouch(){ const stick=document.getElementById('stick'),knob=document.getElementById('stick-knob'); let act=false,cx=0,cy=0;
  const start=e=>{ act=true; const t=e.touches[0]; const r=stick.getBoundingClientRect(); cx=r.left+60; cy=r.top+60; e.preventDefault(); };
  const move=e=>{ if(!act)return; const t=e.touches[0]; let dx=t.clientX-cx,dy=t.clientY-cy; const l=Math.hypot(dx,dy),max=40; if(l>max){dx*=max/l;dy*=max/l;}
    knob.style.left=(35+dx)+'px'; knob.style.top=(35+dy)+'px'; touchMove.x=dx/max; touchMove.y=dy/max; e.preventDefault(); };
  const end=()=>{ act=false; knob.style.left='35px'; knob.style.top='35px'; touchMove.x=0; touchMove.y=0; };
  stick.addEventListener('touchstart',start); stick.addEventListener('touchmove',move); stick.addEventListener('touchend',end);
  // look drag on right half
  let lx=0,ly=0,looking=false;
  addEventListener('touchstart',e=>{ const t=e.touches[e.touches.length-1]; if(t.clientX>innerWidth*0.4){ looking=true; lx=t.clientX; ly=t.clientY; } });
  addEventListener('touchmove',e=>{ if(!looking)return; const t=e.touches[e.touches.length-1]; player.yaw-=(t.clientX-lx)*0.006; player.pitch=Math.max(-1.2,Math.min(0.6,player.pitch-(t.clientY-ly)*0.006)); lx=t.clientX; ly=t.clientY; });
  addEventListener('touchend',()=>{ looking=false; });
}
const raycaster=new THREE.Raycaster();
function handlePick(e){ if(document.getElementById('join').classList.contains('hidden')===false) return;
  const mx=(e.clientX/innerWidth)*2-1, my=-(e.clientY/innerHeight)*2+1; raycaster.setFromCamera({x:mx,y:my},camera);
  // seats
  const ringHits=raycaster.intersectObjects([...seatMarkers.values()].map(s=>s.mesh)); if(ringHits.length){ const id=ringHits[0].object.userData.seatId; if(ws) ws.send(JSON.stringify({type:'sit',seat:id})); return; }
  // bots
  const meshes=[...remote.values()].filter(e=>e.mesh&&e.data&&e.data.kind==='bot').map(e=>e.mesh);
  const hits=raycaster.intersectObjects(meshes,true); if(hits.length){ let o=hits[0].object; while(o&&!o.userData.data) o=o.parent; if(o){ const t=document.getElementById('talktip'); t.textContent=`Say hi to ${o.userData.data.name} — type in chat; they hear you if you're nearby.`; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'),3500);} }
}
function sendStand(){ if(ws) ws.send(JSON.stringify({type:'stand'})); }

// ───────── time-of-day update ─────────
function updateTOD(phase){ const s=todSample(phase);
  skyMat.uniforms.top.value.copy(s.sky); skyMat.uniforms.bottom.value.copy(s.horizon);
  scene.fog.color.copy(s.fog); renderer.setClearColor(s.horizon);
  const elevAngle=s.sunElev*Math.PI*0.5; const az=phase*Math.PI*2;
  const sx=Math.cos(az)*600, sy=Math.sin(Math.max(-0.2,elevAngle))*500, sz=Math.sin(az)*600;
  sunLight.position.set(sx,Math.max(5,sy),sz); sunLight.target.position.set(10,0,45);
  sunLight.color.copy(s.sun); sunLight.intensity=Math.max(0.05,s.sunElev)*2.4;
  hemi.color.copy(s.sky); hemi.groundColor.copy(new THREE.Color(0x3a4a2a)); hemi.intensity=0.3+Math.max(0,s.sunElev)*0.5;
  sunSprite.position.set(sx,Math.max(5,sy),sz); sunSprite.material.opacity=Math.max(0,Math.min(1,s.sunElev+0.3));
  const night=Math.max(0,-s.sunElev+0.1)*2; starField.material.opacity=Math.min(1,night); 
  moon.position.set(-sx,Math.max(-40,-sy)+200,-sz); moon.visible=night>0.1;
  if(fireflyMesh) fireflyMesh.material.opacity=Math.min(0.9,night);
  cloudMesh.children.forEach(c=>c.material.opacity=0.5*Math.max(0.15,Math.min(1,s.sunElev+0.4)));
  bloomPass.strength=s.bloom*0.8; renderer.toneMappingExposure=1.0+s.bloom*0.15;
  clockDiv.textContent=s.name.replace(/([A-Z])/g,' $1').replace(/^./,m=>m.toUpperCase());
}

// ───────── audio (starts after first click; birdsong/wind/water + crickets at night) ─────────
function startAudio(){ if(audioStarted) return; audioStarted=true; try{ audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  const master=audioCtx.createGain(); master.gain.value=muted?0:0.18; master.connect(audioCtx.destination); audioNodes.master=master;
  // wind noise
  const buf=audioCtx.createBuffer(1,audioCtx.sampleRate*2,audioCtx.sampleRate); const dch=buf.getChannelData(0);
  for(let i=0;i<dch.length;i++) dch[i]=(Math.random()*2-1)*0.5; const wind=audioCtx.createBufferSource(); wind.buffer=buf; wind.loop=true;
  const wf=audioCtx.createBiquadFilter(); wf.type='lowpass'; wf.frequency.value=420; const wg=audioCtx.createGain(); wg.gain.value=0.5;
  wind.connect(wf); wf.connect(wg); wg.connect(master); wind.start(); audioNodes.wind=wg;
  // birdsong / cricket oscillator (switched by time)
  const osc=audioCtx.createOscillator(); osc.type='sine'; osc.frequency.value=1600; const og=audioCtx.createGain(); og.gain.value=0; osc.connect(og); og.connect(master); osc.start(); audioNodes.chirp=og; audioNodes.chirpOsc=osc;
}catch(e){ console.warn('audio',e);} }
function toggleMute(){ muted=!muted; document.getElementById('muteBtn').textContent=muted?'🔇':'🔈'; if(audioNodes.master) audioNodes.master.gain.value=muted?0:0.18; }

// ───────── resize ─────────
function onResize(){ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight); composer.setSize(innerWidth,innerHeight); }

// ───────── main loop ─────────
let last=performance.now(),acc=0;
function loop(now){ requestAnimationFrame(loop); const dt=Math.min(0.05,(now-last)/1000); last=now;
  const t=clock.getElapsedTime();
  // day cycle
  dayPhase=(dayPhase+dt/(CFG.timeOfDay.cycleMinutes*60))%1; updateTOD(dayPhase);
  // wind + water + clouds
  windUniforms.time.value=t; windUniforms.windStr.value=CFG.wind.strength*(1+Math.sin(t*0.3)*CFG.wind.gust);
  if(waterMat) waterMat.uniforms.time.value=t;
  cloudMesh.children.forEach(c=>{ c.position.x+=c.userData.sp*dt*2; if(c.position.x>950) c.position.x=-950; });
  // player movement
  if(!player.seated) movePlayer(dt);
  windUniforms.player.value.copy(player.pos);
  // camera (3rd person over-shoulder)
  const camDist=5, camH=3.2; const cx=player.pos.x-Math.sin(player.yaw)*camDist, cz=player.pos.z-Math.cos(player.yaw)*camDist;
  const groundY=terrainHeight(player.pos.x,player.pos.z);
  camera.position.set(cx,groundY+camH+player.pitch*3,cz);
  camera.lookAt(player.pos.x,groundY+1.6,player.pos.z);
  // interpolate remotes
  for(const e of remote.values()){ if(e.mesh&&e.target){ e.mesh.position.x+=(e.target.x-e.mesh.position.x)*0.2; e.mesh.position.z+=(e.target.z-e.mesh.position.z)*0.2;
    e.mesh.position.y=terrainHeight(e.mesh.position.x,e.mesh.position.z); e.mesh.rotation.y=e.target.yaw; } }
  updateLife(t,dt); updatePlates();
  // audio day/night switch
  if(audioNodes.chirp){ const s=todSample(dayPhase); const day=Math.max(0,s.sunElev); audioNodes.chirp.gain.value=muted?0:(0.02+day*0.03); audioNodes.chirpOsc.frequency.value= day>0.1?1600:520; }
  // perf auto step-down
  frameAvg=frameAvg*0.95+dt*1000*0.05; if(CFG.quality.allowAutoStepDown && frameAvg>40){ lowFps++; if(lowFps>120&&quality==='high'){ stepDown(); } } else lowFps=Math.max(0,lowFps-1);
  composer.render();
}
function movePlayer(dt){ let f=0,s=0;
  if(keys['KeyW']||keys['ArrowUp']) f+=1; if(keys['KeyS']||keys['ArrowDown']) f-=1;
  if(keys['KeyA']||keys['ArrowLeft']) s-=1; if(keys['KeyD']||keys['ArrowRight']) s+=1;
  if(isTouch()){ f+=-touchMove.y; s+=touchMove.x; }
  const spd=(CFG.visitorLimits.maxSpeed||7)*dt*(keys['ShiftLeft']?1.6:1);
  const dx=(Math.sin(player.yaw)*f+Math.cos(player.yaw)*s)*spd;
  const dz=(Math.cos(player.yaw)*f-Math.sin(player.yaw)*s)*spd;
  if(f||s){ player.pos.x+=dx; player.pos.z+=dz; const R=CFG.size.worldRadius;
    const dl=Math.hypot(player.pos.x-LAKE.center[0],player.pos.z-LAKE.center[2]); if(dl<LAKE.radius-3){ player.pos.x-=dx; player.pos.z-=dz; }
    if(Math.hypot(player.pos.x-10,player.pos.z-48)>R){ player.pos.x-=dx; player.pos.z-=dz; }
    if(ws&&ws.readyState===1) ws.send(JSON.stringify({type:'move',dx,dz,yaw:player.yaw})); }
}
function updateLife(t,dt){ const o=new THREE.Object3D();
  life.birds.forEach((b,i)=>{ b.a+=b.sp*dt*0.3; const x=10+Math.cos(b.a)*b.r,z=48+Math.sin(b.a)*b.r,y=b.y+Math.sin(t+i)*4;
    o.position.set(x,y,z); o.rotation.y=-b.a; o.scale.setScalar(1+Math.sin(t*6+i)*0.2); o.updateMatrix(); birdMesh.setMatrixAt(i,o.matrix);}); birdMesh.instanceMatrix.needsUpdate=true;
  life.butterflies.forEach((b,i)=>{ b.ph+=dt; const x=b.x+Math.sin(b.ph*1.3)*3.4,z=b.z+Math.cos(b.ph)*3.4,y=terrainHeight(x,z)+1.1+Math.sin(b.ph*3)*0.6;
    o.position.set(x,y,z); o.rotation.set(0,b.ph,Math.sin(t*22+i)*0.7); o.scale.setScalar(b.sc||1); o.updateMatrix(); butterflyMesh.setMatrixAt(i,o.matrix);}); butterflyMesh.instanceMatrix.needsUpdate=true;
  if(dragonflyMesh){ life.dragonflies.forEach((b,i)=>{ b.ph+=dt*b.sp; const x=b.bx+Math.sin(b.ph)*b.rad,z=b.bz+Math.cos(b.ph*0.8)*b.rad,y=0.9+Math.sin(b.ph*2.3)*0.6;
    o.position.set(x,y,z); o.rotation.set(0,b.ph+Math.PI/2,Math.sin(t*34+i)*0.35); o.scale.setScalar(1); o.updateMatrix(); dragonflyMesh.setMatrixAt(i,o.matrix);}); dragonflyMesh.instanceMatrix.needsUpdate=true; }
  life.fish.forEach((b,i)=>{ b.a+=b.sp*dt*0.2; const x=LAKE.center[0]+Math.cos(b.a)*b.r,z=LAKE.center[2]+Math.sin(b.a)*b.r;
    o.position.set(x,-0.8,z); o.rotation.y=-b.a; o.scale.setScalar(1); o.updateMatrix(); fishMesh.setMatrixAt(i,o.matrix);}); fishMesh.instanceMatrix.needsUpdate=true;
  life.animals.forEach(a=>{ a.t-=dt; if(a.t<=0){ a.t=3+Math.random()*5; a.tx=10+(Math.random()-0.5)*160; a.tz=48+(Math.random()-0.5)*160; }
    const dx=a.tx-a.g.position.x,dz=a.tz-a.g.position.z,d=Math.hypot(dx,dz); if(d>0.5){ a.g.position.x+=dx/d*dt*2; a.g.position.z+=dz/d*dt*2; a.g.rotation.y=Math.atan2(dx,dz);} a.g.position.y=terrainHeight(a.g.position.x,a.g.position.z); });
  // ducks & geese drifting on the lake, bobbing gently in the ripples
  life.waterfowl.forEach(w=>{ w.a+=w.sp*dt*0.12; w.ph+=dt;
    const x=LAKE.center[0]+Math.cos(w.a)*w.r, z=LAKE.center[2]+Math.sin(w.a)*w.r;
    w.g.position.set(x, -0.08+Math.sin(w.ph*w.wob)*0.05, z);
    w.g.rotation.y=-w.a+Math.PI/2 + Math.sin(w.ph*0.5)*0.15;
    w.g.rotation.z=Math.sin(w.ph*0.8)*0.05; });
  // firefly flicker
  if(fireflyMesh){ const pos=fireflyMesh.geometry.attributes.position; life.fireflies.forEach((f,i)=>{ f.ph+=dt; pos.setX(i,f.bx+Math.sin(f.ph)*1.5); pos.setZ(i,f.bz+Math.cos(f.ph*0.7)*1.5); pos.setY(i,1.2+Math.sin(f.ph*2)*0.8);}); pos.needsUpdate=true; }
}
function updatePlates(){ for(const e of remote.values()){ if(!e.mesh||!e.plate) continue;
  tmpV.set(e.mesh.position.x,e.mesh.position.y+2.6,e.mesh.position.z); tmpV.project(camera);
  if(tmpV.z>1){ e.plate.style.display='none'; continue; } e.plate.style.display='block';
  e.plate.style.left=((tmpV.x*0.5+0.5)*innerWidth)+'px'; e.plate.style.top=((-tmpV.y*0.5+0.5)*innerHeight)+'px';
  const d=camera.position.distanceTo(e.mesh.position); e.plate.style.opacity=d>60?0:1; } }
function stepDown(){ quality='medium'; qualityDiv.textContent='MEDIUM (auto)'; renderer.setPixelRatio(Math.min(devicePixelRatio,1.25)); if(grassMesh) grassMesh.count=Math.min(grassCount,12000); lowFps=0; }

// Wire the join-card UI immediately (DOM is already parsed for a deferred module), so the
// Beacon Studio, quick-action and share buttons work before the 3D world finishes loading.
try { setupInvite(); } catch (e) { /* non-fatal: boot() still runs the world */ }
boot();
