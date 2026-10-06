/* 地图实体预览 viewer —— 移植自「云朵小铺 · 地图实体预览」单文件版
 * 按图加载 /entity/data/<slug>.bin，列表使用已入库的 /entity/catalog.json。
 * 新实体与地形分片由 scripts/terr-bake/ 从工坊地图包烘焙。
 */
/* =====================================================================
   ★ 3D 渲染引擎（独立于主逻辑，挂到 window.GL3D）
   - 统一材质：全场所有实体共用一套 Lambert + 半球环境光，仅类别色不同
   - 几何：36 顶点单位立方体（6 面），按实体半长缩放平移，一次性填进动态 VBO
   - 环境点用 POINTS 精灵绘制（圆形衰减）
   ===================================================================== */
window.GL3D = (function(){
  const VS = [
    'attribute vec3 aPos;','attribute vec3 aNrm;','attribute vec3 aCol;','attribute float aSel;',
    'uniform mat4 uVP;','varying vec3 vN;','varying vec3 vC;','varying float vS;','varying vec3 vW;',
    'void main(){',
    '  vW = aPos; vN = aNrm; vC = aCol; vS = aSel;',
    '  gl_Position = uVP * vec4(aPos, 1.0);',
    '}'].join('\n');
  const FS = [
    'precision mediump float;',
     'uniform vec3 uEye;','uniform float uAlpha;','uniform float uXray;','uniform float uFogK;','uniform vec3 uFogC;',
    'varying vec3 vN;','varying vec3 vC;','varying float vS;','varying vec3 vW;',
    'void main(){',
    '  if(vS < -0.5) discard;',
    '  vec3 N = normalize(vN);',
    '  vec3 L = normalize(vec3(-0.44, 0.78, 0.45));',
    '  float d  = max(dot(N, L), 0.0);',
    '  float hemi = 0.5 + 0.5 * N.y;',
    '  vec3 amb = mix(vec3(0.40,0.42,0.48), vec3(0.74,0.76,0.82), hemi);',
    '  vec3 col = vC * (amb + d * 0.58);',
    '  vec3 V = normalize(uEye - vW);',
    '  float fr = pow(1.0 - max(dot(N, V), 0.0), 3.0);',
     '  col += fr * 0.12;',
     '  col = mix(col, vec3(1.0), uXray * 0.42);',
    '  float dist = length(uEye - vW);',
    '  float fog = clamp(exp(-dist * uFogK), 0.0, 1.0);',
    '  col = mix(uFogC, col, fog);',
    '  float a = uAlpha * clamp(0.55 + 0.45 * fog, 0.0, 1.0);',
    '  gl_FragColor = vec4(col, a);',
    '}'].join('\n');
  /* ⚠️ 顶点/片元之间**同名 uniform 的精度必须一致**（GLSL ES 1.00 的规定）。
     顶点着色器里不写限定符时默认是 highp，片元着色器里由 `precision mediump float;` 决定 ——
     于是 `uXray` 一个 highp 一个 mediump，桌面 ANGLE 睁只眼闭只眼，
     而手机内核（夸克 U4 / 华为机上实测）会直接链接失败 → 整个 3D 打不开。
     所以跨阶段的 uniform 一律显式写 mediump，两边逐字一致（2026-10-05 实测修复）。 */
  const PVS = [
    'attribute vec3 aPos;','attribute vec3 aCol;','attribute float aSz;',
     'uniform mat4 uVP;','uniform mediump float uPx;','uniform mediump float uXray;',
    'varying vec3 vC;',
    'void main(){',
    '  vC = aCol;',
    '  vec4 p = uVP * vec4(aPos, 1.0);',
    '  gl_Position = p;',
    '  gl_PointSize = clamp(aSz * uPx / max(p.w, 1.0), 1.0, 22.0);',
    '}'].join('\n');
  const PFS = [
    'precision mediump float;',
     'uniform float uAlpha;','uniform mediump float uXray;','uniform vec3 uFogC;','uniform float uFogK;','uniform vec3 uEye;',
    'varying vec3 vC;',
    'void main(){',
    '  vec2 c = gl_PointCoord - vec2(0.5);',
    '  float r2 = dot(c, c);',
    '  if(r2 > 0.25) discard;',
    '  float a = uAlpha * (1.0 - r2 * 3.2);',
     '  gl_FragColor = vec4(mix(vC, vec3(1.0), uXray * 0.42), a * mix(1.0, 0.72, uXray));',
    '}'].join('\n');

  /* --- 真实碰撞地形（地图的 world_physics 碰撞网格）---
     数据：<TERR_BASE>/<工坊ID>.bin（gzip 包 MSH1：量化 u16 位置 + 索引）
     2026-10-04 起 TERR_BASE 指向 Cloudflare R2（terr.ze-map.cn/terr），不再随站点发出；
     着色器自社区工具「云朵小铺 · 地图实体预览」的 preview3d.html 移植；
     地形几何由 Source 2 Viewer 从创意工坊地图包解析。详见 docs/r2-migration.md。 */
  const MVS = [
    'attribute vec3 aPos;','attribute vec3 aNrm;',
    'uniform mat4 uVP;','uniform vec3 uO;','uniform vec3 uS;',
    'varying vec3 vN;','varying vec3 vW;',
    'void main(){',
    '  vec3 s = uO + aPos * uS;',         /* 量化还原：world = o + q * s */
    '  vec3 w = vec3(s.x, s.z, -s.y);',   /* Source（Z 朝上）→ GL（Y 朝上） */
    '  vW = w;',
    '  vN = vec3(aNrm.x, aNrm.z, -aNrm.y);',
    '  gl_Position = uVP * vec4(w, 1.0);',
    '}'].join('\n');
  const MFS = [
    /* 片元着色器里 highp 是**可选**能力：一部分手机 GPU（尤其安卓的 Mali / 老 Adreno）
       不支持，直接写 precision highp float 会让整段着色器编译失败 ——
       而编译失败以前是静默降级到平面视图，表现就是「手机上没有 3D」。
       所以按 GLSL 的标准写法取条件精度：不支持就退到 mediump（雾会略糙，但能画）。 */
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec3 uEye;','uniform float uFogK;','uniform vec3 uFogC;','uniform float uCutY;','uniform float uCutLo;',
    'uniform float uA;',
    'varying vec3 vN;','varying vec3 vW;',
    'void main(){',
    '  if(vW.y > uCutY || vW.y < uCutLo) discard;',   /* 剖切面 */
    '  vec3 N = normalize(vN);',
    '  vec3 L = normalize(vec3(-0.44, 0.78, 0.45));',
    '  float d1 = max(dot(N, L), 0.0);',
    '  float dd = max(d1, max(dot(-N, L), 0.0) * 0.55);',  /* 双面光照：地形是单层薄壳 */
    '  float hemi = 0.5 + 0.5 * abs(N.y);',
    '  vec3 amb = mix(vec3(0.42,0.44,0.50), vec3(0.78,0.79,0.83), hemi);',
    '  vec3 col = vec3(0.66,0.64,0.62) * (amb + dd * 0.50);',
    '  float dist = length(uEye - vW);',
    '  float fog = clamp(exp(-dist * uFogK), 0.0, 1.0);',
    '  col = mix(uFogC, col, fog);',
    '  gl_FragColor = vec4(col, uA);',
    '}'].join('\n');

  /* 单位立方体：6 面 × 6 顶点（三角形环绕直接展开，免索引缓冲）= 36 顶点 */
  const CUBE = (function(){
    const faces = [
      [[0,0,1],  [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]],
      [[0,0,-1], [[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]]],
      [[1,0,0],  [[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]]],
      [[-1,0,0], [[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]]],
      [[0,1,0],  [[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]]],
      [[0,-1,0], [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]]],
    ];
    const tri = [0,1,2,0,2,3];
    const pos = [], nrm = [];
    for(let f=0; f<6; f++){
      const n = faces[f][0], cs = faces[f][1];
      for(let t=0; t<6; t++){
        const k = tri[t];
        pos.push(cs[k][0], cs[k][1], cs[k][2]);
        nrm.push(n[0], n[1], n[2]);
      }
    }
    return { pos:new Float32Array(pos), nrm:new Float32Array(nrm) };
  })();

  let gl=null, prog=null, pprog=null, mprog=null, ready=false, GL2=false;
  let bufB=null, bufP=null, bufM=null, nBox=0, nPt=0, nMesh=0, strideB=0, strideP=0;
  let mO=[0,0,0], mS=[1,1,1];
  const U = {}, UP = {}, UM = {};

  function sh(t, s, label){
    const o = gl.createShader(t);
    gl.shaderSource(o, s); gl.compileShader(o);
    if(!gl.getShaderParameter(o, gl.COMPILE_STATUS)){
      throw new Error(label + ' 编译失败：' + String(gl.getShaderInfoLog(o) || '').trim());
    }
    return o;
  }
  /* 名字带上「哪套 program + 哪个阶段」：手机上的失败原因会显示给用户，
     「着色器编译失败」这种笼统说法没法定位（链接失败也会走到这里）。 */
  function mk(vs, fs, name){
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs, name + ' 顶点着色器'));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs, name + ' 片元着色器'));
    gl.linkProgram(p);
    if(!gl.getProgramParameter(p, gl.LINK_STATUS)){
      throw new Error(name + ' 链接失败：' + String(gl.getProgramInfoLog(p) || '').trim());
    }
    const o = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for(let i=0;i<n;i++){ const u = gl.getActiveUniform(p, i); o[u.name] = gl.getUniformLocation(p, u.name); }
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for(let i=0;i<na;i++){ const a = gl.getActiveAttrib(p, i); o[a.name] = gl.getAttribLocation(p, a.name); }
    return { p, u:o };
  }

  /** 在给定上下文上建好三套 program 与 GL 状态；任何一步失败都抛异常（调用方负责降级重试） */
  function build(c){
    gl = c;
    const a = mk(VS, FS, '实体块'); prog = a.p; Object.assign(U, a.u);
    const b = mk(PVS, PFS, '点云'); pprog = b.p; Object.assign(UP, b.u);
    const d = mk(MVS, MFS, '地形'); mprog = d.p; Object.assign(UM, d.u);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    bufB = gl.createBuffer(); bufP = gl.createBuffer(); bufM = gl.createBuffer();
    ready = true;
  }

  const OPTS = [
    {alpha:true, antialias:true, premultipliedAlpha:false, depth:true, preserveDrawingBuffer:true},
    {alpha:true, antialias:false, premultipliedAlpha:false, depth:true, preserveDrawingBuffer:true},
    {alpha:true, depth:true, preserveDrawingBuffer:true},
    {alpha:false, depth:true},
  ];
  const KINDS = ['webgl2', 'webgl', 'experimental-webgl'];
  const tagOf = (o, k) => k + (o.antialias ? '+aa' : '') + (o.preserveDrawingBuffer ? '+pdb' : '');

  /**
   * 初始化 3D。
   *
   * 为什么要「临时 canvas 先探一遍」：**一张 canvas 只能绑定一种上下文** ——
   * 一旦在 cv3 上拿到 webgl2，之后想退回 webgl1 是拿不到的（getContext 只会返回 null）。
   * 而手机上的失败往往正是「webgl2 拿得到、着色器却编译不过」，
   * 所以先用一张一次性 canvas 试通「上下文 + 三套 program」，再动正式那张。
   *
   * 失败原因全部收集进 window.__glerr（会显示在页面上，方便用户直接反馈）。
   */
  function init(cv){
    const errs = [];
    for(const kind of KINDS){
      if(kind !== 'webgl2' && typeof window.WebGLRenderingContext === 'undefined') continue;

      /* 第一关：这种上下文类型在这台设备上到底能不能跑我们的着色器。
         用一次性 canvas 探（正式那张只能绑一种上下文，探错了就回不了头），
         每种类型只探一次，免得把浏览器的 WebGL 上下文数量上限吃满。 */
      let why = '';
      try{
        const pc = document.createElement('canvas').getContext(kind, OPTS[0]);
        if(!pc) why = '拿不到上下文';
        else { try{ build(pc); }catch(e){ why = String(e.message || e).slice(0, 110); } }
      }catch(e){ why = '抛异常：' + e.message; }
      /* 着色器编译/链接失败时，三种上下文类型给出的原因通常逐字相同（同一份源码、同一个编译器）
         —— 收集时先按 kind 记着，最后再去重，免得页面上把同一句话重复三遍 */
      if(why){ errs.push({ kind, why }); continue; }

      /* 第二关：正式 canvas 上按属性逐级降级 */
      for(const opt of OPTS){
        let real;
        try{ real = cv.getContext(kind, opt); }
        catch(e){ errs.push({ kind: tagOf(opt, kind), why: '正式 canvas 抛异常：' + e.message }); continue; }
        if(!real){ errs.push({ kind: tagOf(opt, kind), why: '正式 canvas 拿不到上下文' }); continue; }
        if(real.isContextLost && real.isContextLost()){ errs.push({ kind: tagOf(opt, kind), why: '上下文已被回收' }); continue; }
        try{
          build(real);
          GL2 = kind === 'webgl2';
          window.__glerr = '';
          return true;
        }catch(e){
          errs.push({ kind: tagOf(opt, kind), why: '正式初始化失败：' + String(e.message || e).slice(0, 110) });
        }
      }
    }
    ready = false; gl = null;
    const whys = [...new Set(errs.map((e) => e.why))];
    window.__glerr = !errs.length ? '未知原因'
      : whys.length === 1 ? `${whys[0]}（${errs.map((e) => e.kind).join(' / ')} 都试过了）`
      : errs.slice(0, 3).map((e) => e.kind + '：' + e.why).join('；');
    return false;
  }

  /* boxes: [{x,y,z,ex,ey,ez,c:[r,g,b],a}]  —— 半长为 ex/ey/ez */
  function setBoxes(boxes){
    const n = boxes.length|0;
    nBox = n;
    if(!n || !gl) return;
    const S = 11;                       // pos3 nrm3 col3 sel1 alpha1
    strideB = S * 4;
    const d = new Float32Array(n * 36 * S);
    const P = CUBE.pos, N = CUBE.nrm;
    let o = 0;
    for(let i=0;i<n;i++){
      const b = boxes[i];
      const x=b.x, y=b.y, z=b.z, ex=b.ex, ey=b.ey, ez=b.ez;
      const c=b.c, al=b.a===undefined?1:b.a, sel=b.s?1:0;
      for(let k=0;k<36;k++){
        d[o++] = x + P[k*3]*ex;
        d[o++] = y + P[k*3+1]*ey;
        d[o++] = z + P[k*3+2]*ez;
        d[o++] = N[k*3]; d[o++] = N[k*3+1]; d[o++] = N[k*3+2];
        d[o++] = c[0]; d[o++] = c[1]; d[o++] = c[2];
        d[o++] = sel; d[o++] = al;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufB);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
  }
  /* pts: Float32Array [x,y,z,r,g,b,size] × n */
  function setPoints(arr){
    nPt = (arr.length / 7) | 0;
    if(!nPt || !gl) return;
    strideP = 7 * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufP);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
  }

  /* 地形网格：verts = Uint16Array(nv*3 量化位置)，idxs = Uint16/Uint32Array(nt*3)，
     o = 源坐标原点，s = 源坐标缩放（world = o + q * s，在顶点着色器里算）。
     这里按三角形展开成静态交错缓冲（每顶点 12B：3×u16 位置 + 3×i8 法线 + 2 字节填充），
     法线按三角形平面现算 —— 原始数据里没有法线，这样够用且免去逐顶点平均。
     走 drawArrays 而不是 drawElements：展开后就能和块体共用同一套绘制路径，
     也避开了 WebGL1 下 u32 索引要扩展的限制。 */
  function setMesh(verts, idxs, o, s, nt){
    nMesh = nt | 0;
    if(!nMesh || !gl) return;
    mO = [o[0], o[1], o[2]]; mS = [s[0], s[1], s[2]];
    const d = new Uint8Array(nMesh * 3 * 12);
    const dv = new DataView(d.buffer);
    let p = 0;
    for(let i=0;i<nMesh;i++){
      const i0 = idxs[i*3]*3, i1 = idxs[i*3+1]*3, i2 = idxs[i*3+2]*3;
      const ax = o[0]+verts[i0]*s[0], ay = o[1]+verts[i0+1]*s[1], az = o[2]+verts[i0+2]*s[2];
      const bx = o[0]+verts[i1]*s[0], by = o[1]+verts[i1+1]*s[1], bz = o[2]+verts[i1+2]*s[2];
      const cx = o[0]+verts[i2]*s[0], cy = o[1]+verts[i2+1]*s[1], cz = o[2]+verts[i2+2]*s[2];
      let nx = (by-ay)*(cz-az) - (bz-az)*(cy-ay);
      let ny = (bz-az)*(cx-ax) - (bx-ax)*(cz-az);
      let nz = (bx-ax)*(cy-ay) - (by-ay)*(cx-ax);
      const l = Math.hypot(nx, ny, nz) || 1;
      nx = Math.round(nx/l*127); ny = Math.round(ny/l*127); nz = Math.round(nz/l*127);
      for(let k=0;k<3;k++){
        const vi = (k===0?i0:k===1?i1:i2);
        dv.setUint16(p,     verts[vi],   true);
        dv.setUint16(p + 2, verts[vi+1], true);
        dv.setUint16(p + 4, verts[vi+2], true);
        dv.setInt8(p + 6, nx); dv.setInt8(p + 7, ny); dv.setInt8(p + 8, nz);
        p += 12;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufM);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
  }
  function clearMesh(){ nMesh = 0; }

  function clear(){
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }
  /* 4x4 列主序矩阵工具 */
  const M4 = {
    ident: () => new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),
    mul(a, b){
      const o = new Float32Array(16);
      for(let i=0;i<4;i++){
        const a0=a[i], a1=a[i+4], a2=a[i+8], a3=a[i+12];
        o[i]    = a0*b[0] + a1*b[1] + a2*b[2]  + a3*b[3];
        o[i+4]  = a0*b[4] + a1*b[5] + a2*b[6]  + a3*b[7];
        o[i+8]  = a0*b[8] + a1*b[9] + a2*b[10] + a3*b[11];
        o[i+12] = a0*b[12]+ a1*b[13]+ a2*b[14] + a3*b[15];
      }
      return o;
    },
    persp(fovy, asp, zn, zf){
      const f = 1 / Math.tan(fovy / 2);
      return new Float32Array([
        f/asp,0,0,0, 0,f,0,0,
        0,0,(zf+zn)/(zn-zf),-1, 0,0,(2*zf*zn)/(zn-zf),0]);
    },
    look(eye, ctr, up){
      let z0=eye[0]-ctr[0], z1=eye[1]-ctr[1], z2=eye[2]-ctr[2];
      let l = Math.hypot(z0,z1,z2)||1; z0/=l; z1/=l; z2/=l;
      let x0=up[1]*z2-up[2]*z1, x1=up[2]*z0-up[0]*z2, x2=up[0]*z1-up[1]*z0;
      l = Math.hypot(x0,x1,x2)||1; x0/=l; x1/=l; x2/=l;
      const y0=z1*x2-z2*x1, y1=z2*x0-z0*x2, y2=z0*x1-z1*x0;
      return new Float32Array([
        x0,y0,z0,0, x1,y1,z1,0, x2,y2,z2,0,
        -(x0*eye[0]+x1*eye[1]+x2*eye[2]),
        -(y0*eye[0]+y1*eye[1]+y2*eye[2]),
        -(z0*eye[0]+z1*eye[1]+z2*eye[2]), 1]);
    },
  };

  function draw(cam){
    if(!ready) return;
    clear();
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const fogK = cam.fogK === undefined ? 0 : cam.fogK;

    /* --- 地形网格（真实碰撞几何）：最先画，作为其它实体的底 ---
       关掉背面剔除：地形是从地图包解析出的单层薄壳，正反面都要可见。
       半透明时（cam.topa < 1）不写深度，避免挡住后面的块体。 */
    if(nMesh && cam.terrain !== false){
      const ta = cam.topa === undefined ? 1.0 : cam.topa;
       if(ta > 0){
         gl.useProgram(mprog);
         gl.disable(gl.CULL_FACE);
         for(let i=0;i<8;i++) gl.disableVertexAttribArray(i);
        gl.uniformMatrix4fv(UM.uVP, false, cam.vp);
        gl.uniform3f(UM.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
        gl.uniform1f(UM.uFogK, fogK);
        gl.uniform3f(UM.uFogC, cam.fog[0], cam.fog[1], cam.fog[2]);
        gl.uniform1f(UM.uCutY, cam.cutY === undefined ? 1e9 : cam.cutY);
        gl.uniform1f(UM.uCutLo, cam.cutLo === undefined ? -1e9 : cam.cutLo);
        gl.uniform1f(UM.uA, ta);
        gl.uniform3f(UM.uO, mO[0], mO[1], mO[2]);
        gl.uniform3f(UM.uS, mS[0], mS[1], mS[2]);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufM);
        gl.vertexAttribPointer(UM.aPos, 3, gl.UNSIGNED_SHORT, false, 12, 0);
        gl.vertexAttribPointer(UM.aNrm, 3, gl.BYTE, true, 12, 6);
        gl.enableVertexAttribArray(UM.aPos);
         gl.enableVertexAttribArray(UM.aNrm);
         gl.drawArrays(gl.TRIANGLES, 0, nMesh * 3);
         gl.depthMask(true);
        gl.enable(gl.CULL_FACE);
      }
    }

    /* --- 块体（drawArrays：顶点数据已展开三角形环绕，无索引上限） --- */
    if(nBox && cam.solid){
      gl.useProgram(prog);
      gl.enable(gl.CULL_FACE);
      for(let i=0;i<8;i++) gl.disableVertexAttribArray(i);
      gl.uniformMatrix4fv(U.uVP, false, cam.vp);
       gl.uniform3f(U.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
       gl.uniform1f(U.uAlpha, cam.alpha);
       gl.uniform1f(U.uXray, 0.0);
      gl.uniform1f(U.uFogK, fogK);
      gl.uniform3f(U.uFogC, cam.fog[0], cam.fog[1], cam.fog[2]);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufB);
      gl.vertexAttribPointer(U.aPos, 3, gl.FLOAT, false, strideB, 0);
      gl.vertexAttribPointer(U.aNrm, 3, gl.FLOAT, false, strideB, 12);
      gl.vertexAttribPointer(U.aCol, 3, gl.FLOAT, false, strideB, 24);
      gl.vertexAttribPointer(U.aSel, 1, gl.FLOAT, false, strideB, 36);
      gl.enableVertexAttribArray(U.aPos);
      gl.enableVertexAttribArray(U.aNrm);
      gl.enableVertexAttribArray(U.aCol);
      gl.enableVertexAttribArray(U.aSel);
      gl.drawArrays(gl.TRIANGLES, 0, nBox * 36);
    }

    /* --- 环境点 --- */
    if(nPt){
      gl.useProgram(pprog);
      gl.disable(gl.CULL_FACE);
      gl.depthMask(false);
      for(let i=0;i<8;i++) gl.disableVertexAttribArray(i);
      gl.uniformMatrix4fv(UP.uVP, false, cam.vp);
       gl.uniform1f(UP.uPx, cam.px);
       gl.uniform1f(UP.uAlpha, cam.pAlpha);
       gl.uniform1f(UP.uXray, 0.0);
      gl.uniform1f(UP.uFogK, fogK);
      gl.uniform3f(UP.uFogC, cam.fog[0], cam.fog[1], cam.fog[2]);
      gl.uniform3f(UP.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufP);
      gl.vertexAttribPointer(UP.aPos, 3, gl.FLOAT, false, strideP, 0);
      gl.vertexAttribPointer(UP.aCol, 3, gl.FLOAT, false, strideP, 12);
      gl.vertexAttribPointer(UP.aSz, 1, gl.FLOAT, false, strideP, 24);
      gl.enableVertexAttribArray(UP.aPos);
      gl.enableVertexAttribArray(UP.aCol);
      gl.enableVertexAttribArray(UP.aSz);
       gl.drawArrays(gl.POINTS, 0, nPt);
       gl.depthMask(true);
     }

     /* --- 地形穿透高亮：保留地形原有深度与透明度，只补画被地形挡住的实体 ---
        GREATER 只通过实体深度大于地形深度的片段，因此前景实体不会被重复
        变亮；高亮采用偏白颜色与较低透明度，效果类似《我的世界》的透视提示。 */
     if(nMesh && cam.terrain !== false && (cam.topa === undefined || cam.topa > 0)){
       if(nBox && cam.solid){
         gl.useProgram(prog);
         gl.enable(gl.CULL_FACE);
         gl.depthFunc(gl.GREATER);
         gl.depthMask(false);
         for(let i=0;i<8;i++) gl.disableVertexAttribArray(i);
         gl.uniformMatrix4fv(U.uVP, false, cam.vp);
         gl.uniform3f(U.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
         gl.uniform1f(U.uAlpha, cam.alpha * 0.78);
         gl.uniform1f(U.uXray, 1.0);
         gl.uniform1f(U.uFogK, fogK);
         gl.uniform3f(U.uFogC, cam.fog[0], cam.fog[1], cam.fog[2]);
         gl.bindBuffer(gl.ARRAY_BUFFER, bufB);
         gl.vertexAttribPointer(U.aPos, 3, gl.FLOAT, false, strideB, 0);
         gl.vertexAttribPointer(U.aNrm, 3, gl.FLOAT, false, strideB, 12);
         gl.vertexAttribPointer(U.aCol, 3, gl.FLOAT, false, strideB, 24);
         gl.vertexAttribPointer(U.aSel, 1, gl.FLOAT, false, strideB, 36);
         gl.enableVertexAttribArray(U.aPos);
         gl.enableVertexAttribArray(U.aNrm);
         gl.enableVertexAttribArray(U.aCol);
         gl.enableVertexAttribArray(U.aSel);
         gl.drawArrays(gl.TRIANGLES, 0, nBox * 36);
       }
       if(nPt){
         gl.useProgram(pprog);
         gl.disable(gl.CULL_FACE);
         gl.depthFunc(gl.GREATER);
         gl.depthMask(false);
         for(let i=0;i<8;i++) gl.disableVertexAttribArray(i);
         gl.uniformMatrix4fv(UP.uVP, false, cam.vp);
         gl.uniform1f(UP.uPx, cam.px);
         gl.uniform1f(UP.uAlpha, cam.pAlpha * 0.78);
         gl.uniform1f(UP.uXray, 1.0);
         gl.uniform1f(UP.uFogK, fogK);
         gl.uniform3f(UP.uFogC, cam.fog[0], cam.fog[1], cam.fog[2]);
         gl.uniform3f(UP.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
         gl.bindBuffer(gl.ARRAY_BUFFER, bufP);
         gl.vertexAttribPointer(UP.aPos, 3, gl.FLOAT, false, strideP, 0);
         gl.vertexAttribPointer(UP.aCol, 3, gl.FLOAT, false, strideP, 12);
         gl.vertexAttribPointer(UP.aSz, 1, gl.FLOAT, false, strideP, 24);
         gl.enableVertexAttribArray(UP.aPos);
         gl.enableVertexAttribArray(UP.aCol);
         gl.enableVertexAttribArray(UP.aSz);
         gl.drawArrays(gl.POINTS, 0, nPt);
       }
       gl.depthMask(true);
       gl.depthFunc(gl.LEQUAL);
       gl.enable(gl.CULL_FACE);
     }
   }
  /* 线段（网格 / 坐标轴）：每帧重建，量小 */
  let lineBuf = null, lineProg = null, lineU = {};
  const LVS = 'attribute vec3 aPos; attribute vec3 aCol; uniform mat4 uVP;' +
              'varying vec3 vC; void main(){ vC=aCol; gl_Position = uVP*vec4(aPos,1.0); }';
  const LFS = 'precision mediump float; varying vec3 vC; uniform float uA;' +
              'void main(){ gl_FragColor = vec4(vC, uA); }';
  function initLines(){
    if(lineProg) return;
    const r = mk(LVS, LFS);
    lineProg = r.p; lineU = r.u;
    lineBuf = gl.createBuffer();
  }
  function drawLines(arr, alpha){
    if(!arr.length) return;
    initLines();
    gl.useProgram(lineProg);
    gl.uniformMatrix4fv(lineU.uVP, false, curVP);
    gl.uniform1f(lineU.uA, alpha);
    gl.disable(gl.CULL_FACE);
    // 清掉其它程序遗留的 enabled 属性，避免读到过小的缓冲导致整批绘制失败
    for(let i=0;i<8;i++) gl.disableVertexAttribArray(i);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(lineU.aPos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(lineU.aCol, 3, gl.FLOAT, false, 24, 12);
    gl.enableVertexAttribArray(lineU.aPos);
    gl.enableVertexAttribArray(lineU.aCol);
    gl.drawArrays(gl.LINES, 0, arr.length / 6);
  }
  let curVP = null;

  return {
    init, setBoxes, setPoints, draw, drawLines, M4, clear, CUBE,
    setMesh, clearMesh,
    get ok(){ return ready; }, get isGL2(){ return GL2; },
    get boxCount(){ return nBox; }, get ptCount(){ return nPt; },
    get meshCount(){ return nMesh; },
    setVP(v){ curVP = v; },
  };
})();
"use strict";
/* ============================ 数据加载 ============================ */
/* 网站版：数据不再内嵌在页面里，改为两级按需加载
 *   1) 启动只取 /entity/catalog.json —— 全部地图的索引（约 90 KB gzip），侧栏列表用
 *   2) 选中某张图时再取 /entity/data/<slug>.bin —— 该图的 gzip 分片（平均约 16 KB）
 * 分片格式与原单文件完全一致：[4B 小端 JSON 长度][JSON][BIN]，整体 gzip。
 */
const DATA_BASE = window.__ENTITY_BASE__ || '/entity';
/* 真实碰撞地形分包（<TERR_BASE>/<工坊ID>.bin，线上是 R2），与实体数据同样按需加载 */
const TERR_BASE = window.__TERR_BASE__ || '/terr';
let BIN = null;                   // 当前图的二进制块区（密度底图 + 雷达 webp）
let CATALOG = null;               // 全部地图索引
const payloadCache = new Map();   // slug -> payload，重复切换不再请求

function hasDS(){ return typeof DecompressionStream === 'function'; }

async function fetchCatalog(){
  const res = await fetch(`${DATA_BASE}/catalog.json`);
  if(!res.ok) throw new Error(`目录加载失败 HTTP ${res.status}`);
  return res.json();
}

async function fetchMapPayload(slug){
  if(payloadCache.has(slug)) return payloadCache.get(slug);
  if(!hasDS()){
    throw new Error('当前浏览器不支持解压（DecompressionStream），请用较新的 Chrome / Edge 打开');
  }
  const res = await fetch(`${DATA_BASE}/data/${slug}.bin`);
  if(!res.ok) throw new Error(`地图数据加载失败 HTTP ${res.status}`);
  const ab = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const jlen = new DataView(ab).getUint32(0, true);
  const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, jlen)));
  payload.bin = new Uint8Array(ab, 4 + jlen);
  payloadCache.set(slug, payload);
  return payload;
}

/* ===== 真实碰撞地形（可关的图层）=====
 * 数据：<TERR_BASE>/<工坊ID>.bin —— gzip 包着 MSH1 头 + 量化顶点 + 索引（线上取 R2）。
 *   'MSH1' | u32 nv | u32 nt | u32 u16i | f32×3 原点 o | f32×3 缩放 s | u16 顶点 | 索引
 * 与实体数据一样按需加载：打开某张图才拉那张的分包（约 400 KB gzip）。
 * 分包缺失（快照之后上架的新图）或解压失败时静默降级 —— 清空网格，其余照常。
 */
const meshCache = new Map();   // 工坊ID -> Promise<{verts, idxs, o, s, nt}>
let meshErrKey = null;         // 加载失败的那张图（状态行显示「本地无地形」）

/* 缓存的是 Promise 而不是结果：进 3D 与切图会几乎同时触发两次刷新，
   缓存结果的话两次都会穿透、把同一个分包下载两遍（实测 408 KB × 2）。
   失败的不留在缓存里，下次切换还能重试。 */

/*
 * 分片从哪取：主用 R2 自定义域（terr.ze-map.cn，快、不占 Worker），
 * 失败就退回**同源** /terr/<id>.bin（Worker 代理同一个 R2 桶）。
 *
 * 为什么要这条回退：R2 是另一个域名，国内手机网络 / 内置浏览器里会直接
 * 「Failed to fetch」（跨域被拦、或那个域根本不通），而站点自己的域名是通的 ——
 * 用户看到的就是「真实碰撞地形加载失败：Failed to fetch」，隐藏块体后一片空（2026-10-05 反馈）。
 * 一旦回退成功就记住，后续换图不再先撞一次失败（`terrBase` 只在本次会话内缓存）。
 */
const TERR_FALLBACK = '/terr';
/* 记住上次成功的来源：如果这台设备连不上 R2 域（下面注释里那种情况），
   第二次进来就直接走同源，不再先撞一次几十秒的失败。 */
let terrBase = (() => {
  try { return localStorage.getItem('zmTerrBase') || TERR_BASE; } catch { return TERR_BASE; }
})();
let terrBaseNote = terrBase === TERR_BASE ? '' : '上次这条通';   // 给诊断用
let terrReach = '';             // 给诊断用：R2 域到底通不通（失败时探一次）

/** 取一个分片（含回退）。404 也回退 —— 同源那条会给出更准确的 404/503。 */
async function fetchTerrShard(wf){
  /* 两条路都试：记住的那条优先，另一条兜底 */
  const bases = terrBase === TERR_FALLBACK ? [TERR_FALLBACK, TERR_BASE] : [terrBase, TERR_FALLBACK];
  let lastErr = null;
  for(const base of bases){
    try{
      const res = await fetch(`${base}/${wf}.bin`);
      if(!res.ok){
        lastErr = new Error(`没有这张图的地形分包（HTTP ${res.status}）`);
        continue;
      }
      if(base !== terrBase){
        terrBase = base;
        terrBaseNote = base === TERR_FALLBACK ? '已回退到同源 /terr' : '已切回 R2 域';
        try { localStorage.setItem('zmTerrBase', base); } catch {}
      }
      return res;
    }catch(err){
      /* 网络层失败：Failed to fetch / 跨域被拦 / 断网。换下一条路再试 */
      lastErr = new Error((err && err.message) ? err.message : '网络错误');
    }
  }
  throw lastErr || new Error('取不到地形分包');
}

function fetchTerrMesh(wf){
  if(meshCache.has(wf)) return meshCache.get(wf);
  const p = (async () => {
    if(!hasDS()) throw new Error('浏览器不支持解压（DecompressionStream）');
    const res = await fetchTerrShard(wf);
    const ab = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const dv = new DataView(ab);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if(magic !== 'MSH1') throw new Error('地形分包格式不对（缺少 MSH1 标识）');
    let p2 = 4;
    const nv = dv.getUint32(p2, true); p2 += 4;
    const nt = dv.getUint32(p2, true); p2 += 4;
    const u16i = dv.getUint32(p2, true); p2 += 4;
    const o = [dv.getFloat32(p2, true), dv.getFloat32(p2+4, true), dv.getFloat32(p2+8, true)]; p2 += 12;
    const s = [dv.getFloat32(p2, true), dv.getFloat32(p2+4, true), dv.getFloat32(p2+8, true)]; p2 += 12;
    const verts = new Uint16Array(ab, p2, nv * 3); p2 += nv * 6;
    if(!u16i) p2 = (p2 + 3) & ~3;                  // u32 索引要 4 字节对齐
    const idxs = u16i ? new Uint16Array(ab, p2, nt * 3) : new Uint32Array(ab, p2, nt * 3);
    return { verts, idxs, o, s, nt };
  })();
  p.catch(() => meshCache.delete(wf));
  if(meshCache.size > 4) meshCache.delete(meshCache.keys().next().value);
  meshCache.set(wf, p);
  return p;
}

/* 按当前选中图与开关刷新地形网格（切图 / 切开关 / 切 2D↔3D 都要走这里） */
async function refreshTerrain(){
  const wf = S.entry && S.entry.f;
  if(!GLok || S.mode !== '3d' || !S.terrain || !wf){
    GL3D.clearMesh(); meshErrKey = null; updateTerrRow(); return;
  }
  const forKey = S.key;
  try{
    const e = await fetchTerrMesh(wf);
    if(forKey !== S.key) return;              // 期间切走了，结果丢弃
    GL3D.setMesh(e.verts, e.idxs, e.o, e.s, e.nt);
    buildHeightField(e);                      // 行走模式要用的地面高度场，跟网格一起建
    meshErrKey = null;
  }catch(err){
    GL3D.clearMesh();
    HFG = null;
    if(CAM.walk) setWalk(false);              // 地形没了就没法贴地，退出行走
    meshErrKey = forKey;
    const why = err && err.message ? err.message : String(err);
    console.warn('地形加载失败：' + why);
    /* 光在图层面板里写一行小字没人会注意 —— 用户会以为「这张图本来就没有地形」，
       然后发现「隐藏块体后什么都没有」。这里直接弹一句，并说明去哪重试。 */
    if(S.mode === '3d' && S.terrain) flashMsg('真实碰撞地形加载失败：' + why + '（图层面板里那行可以点着重试）', 9000);
  }
  updateTerrRow();
  if(S.mode === '3d') render3D();
}

/* 工具面板里那行状态文字。
   失败时写成可点的一句话，而不是干巴巴的「本地无地形」—— 地形是从 R2 拉的，
   手机上网络抖一下、或者本地预览用的 origin 不在 R2 的 CORS 白名单里，都会失败，
   而用户看到「无地形」只能以为这张图本来就没有（2026-10-05 反馈）。 */
function updateTerrRow(){
  const st = $('tstat');
  if(!st) return;
  const wf = S.entry && S.entry.f;
  st.style.cursor = '';
  st.title = '';
  if(!S.terrain) st.textContent = '已关';
  else if(!wf) st.textContent = '此图无数据';
  else if(meshErrKey === S.key){
    st.textContent = '加载失败 · 点此重试';
    st.style.cursor = 'pointer';
    st.title = '取地形分片失败：R2 域（' + TERR_BASE + '）与同源 ' + TERR_FALLBACK +
      ' 都试过了。可能是网络问题，也可能是这张图还没上传。点一下重试。';
    /* 顺手探一下主机到底通不通：no-cors 能成功说明「域名可达、是跨域被拦」，
       拿不到就说明「根本不通」—— 这两种原因的修法完全不同，反馈时有用。 */
    terrReach = '探测中…';
    fetch(TERR_BASE + '/__reach_probe__', { mode: 'no-cors', cache: 'no-store' })
      .then(() => { terrReach = TERR_BASE + ' 可达（跨域被拦）'; })
      .catch((e) => { terrReach = TERR_BASE + ' 不可达（' + (e && e.message ? e.message : '网络错误') + '）'; });
  }
  else if(GL3D.meshCount) st.textContent = fmt(GL3D.meshCount) + ' 面';
  else st.textContent = '加载中…';
}

/* 打开一张图：拉分片 → 组装成原版 DATA 结构（maps 里只有这一张）→ 复用原有渲染流程 */
async function openMap(entry){
  if(!entry) return;
  const payload = await fetchMapPayload(entry.s);
  BIN = payload.bin;
  payload.map.__k = entry.k;
  payload.maps = { [entry.k]: payload.map };
  DATA = payload;
  CLS = payload.classes;
  MAPKEYS = [entry.k];
  S.entry = entry;
  if(S.listMode && entry.a !== S.listMode){ S.listMode = entry.a; const sel = $('lmode'); if(sel) sel.value = entry.a; }
  loadMap(entry.k);
}

function syncUrl(slug){
  try{
    const u = new URL(location.href);
    u.searchParams.set('map', slug);
    history.replaceState(null, '', u);
  }catch(e){ /* file:// 等场景忽略 */ }
}

let DATA=null, GMAP={}, CLS=[], MAPKEYS=[];
const S = { key:null, entry:null, listMode:'2001', mode:'3d', proj:'xy', hcol:false, psize:3, glow:false, full:false,
            off:new Set(), solo:null, sort:'k', bmap:true, bop:0.6, sel:null,
            coff:new Set(), xopen:new Set(),
            vbox:true, vbig:false, bopa:0.88, cutz:1, stage:0, terrain:true,
            /* 显示设置（对齐云朵小铺那块面板）：块体大小 / 点云大小 / 地形不透明度 / 切掉此高度以下 */
            bsz:1, psz:1, topa:1, cutb:0 };
let view = {s:1, ox:0, oy:0};
/* 关卡过滤：0=全部 · -1=未标注 · n=第 n 关 */
function stageOk(o){
  if(!S.stage) return true;
  return S.stage === -1 ? !o.sg : o.sg === S.stage;
}

/* ---------------- 3D 相机 ---------------- */
/* 单位换算：Source 1 单位 ≈ 2.54cm。行走相关的常量按米写，用这个换成世界单位。 */
const UNITS_PER_M = 39.3701;

const CAM = {
  tx:0, ty:0, tz:0,        // 目标点（世界坐标）
  dist:4000,               // 眼睛到目标距离
  yaw:-Math.PI/2, pitch:0.62,
  fogK:0, fog:[0.72,0.75,0.82],
  ready:false, lastT:0,
  /* --- 自由视角 / 行走模式（移植自「云朵小铺」预览页的相机） ---
     free=true 时眼睛位置由 ex/ey/ez 决定（轨道目标点不再参与）；
     walk=true 表示在 free 基础上贴地（沿视线水平移动，眼高跟随地形高度场）。 */
  free:false, walk:false,
  ex:0, ey:0, ez:0,        // 眼睛位置（世界坐标）
  eyeH:1.7,                // 行走眼高（米，滑杆可调）
  wspd:1,                  // 行走速度倍率（滚轮 0.25~6x，记忆）
  fspd:1,                  // 自由飞行移速倍率（滑杆 0.1~5x，记忆）
  wtgt:0,                  // 贴地目标眼高（用于上坡快贴 / 下坡平滑）
  msens:1,                 // 鼠标灵敏度（滑杆 0.3~3x）
};
function mapSpan(){
  const bb = (cur && cur.m && cur.m.fb) || [0,0,0,1,1,1];
  return Math.max(bb[3]-bb[0], bb[4]-bb[1], bb[5]-bb[2], 256);
}
function camEye(){
  if(CAM.free) return [CAM.ex, CAM.ey, CAM.ez];
  const cp = Math.cos(CAM.pitch), sp = Math.sin(CAM.pitch);
  return [CAM.tx + CAM.dist*cp*Math.cos(CAM.yaw),
          CAM.ty + CAM.dist*sp,
          CAM.tz + CAM.dist*cp*Math.sin(CAM.yaw)];
}
function camDir(){
  const cp = Math.cos(CAM.pitch), sp = Math.sin(CAM.pitch);
  return [-cp*Math.cos(CAM.yaw), -sp, -cp*Math.sin(CAM.yaw)];
}
function camVP(){
  const eye = camEye();
  const d = camDir();
  const span = mapSpan();
  /* 近裁剪面：第一人称要贴到 0.1m 左右，否则贴墙时会把眼前削掉 */
  const near = CAM.walk ? 0.1*UNITS_PER_M
             : CAM.free ? Math.max(2, span*0.0005)
             : Math.max(4, CAM.dist*0.004);
  const far = CAM.free ? span*24 : CAM.dist*14;
  const p = GL3D.M4.persp(45*Math.PI/180, (W||1)/(H||1), near, far);
  const v = GL3D.M4.look(eye,
      CAM.free ? [eye[0]+d[0], eye[1]+d[1], eye[2]+d[2]] : [CAM.tx, CAM.ty, CAM.tz],
      [0,1,0]);
  return { eye, vp: GL3D.M4.mul(p, v) };
}

/* ============================ 自由视角 / 行走模式 ============================
 * 移植自「云朵小铺 · 地图实体预览」（preview3d.html）的相机与行走实现：
 *   V 切行走 · F 切自由飞行 · 行走时 WASD 走 / 左键拖拽环顾 / G 下穿楼层 / 滚轮调速
 *   飞行时 WASD 平移 · E 或空格升 / Q 或 C 降 · 滚轮前进后退 · Shift 疾跑
 * 单位差异：原实现全程用米，本站用 Source 单位，所以行走相关的常量都乘 UNITS_PER_M
 * （18 m/s 的步速、1.7m 眼高、0.6m 台阶容差、1.2m 爬升上限）。
 * 行走没有墙体碰撞，只贴地 —— 和软件里一样，定位是「跑图认路」。
 */
const FLYKEYS = new Set();
let flyRaf = 0, flyLast = 0, perfAcc = 0, perfN = 0, RSCALE = 1;

/* 地面高度场：把地形网格按 2m 分格，记下每格里所有三角形的 z（Source 坐标，z 朝上） */
const HF_CELL = 2 * UNITS_PER_M;
let HFG = null;

function buildHeightField(e){
  HFG = null;
  if(!e || !e.nt || !e.verts) return;
  const v = e.verts, o = e.o, s = e.s, cs = HF_CELL;
  let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
  for(let i=0;i<v.length;i+=3){
    const x = o[0]+v[i]*s[0], y = o[1]+v[i+1]*s[1];
    if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
  }
  const gw = Math.ceil((x1-x0)/cs)+1;
  const cells = new Map();
  for(let t=0;t<e.nt;t++){
    const i0=e.idxs[t*3]*3, i1=e.idxs[t*3+1]*3, i2=e.idxs[t*3+2]*3;
    const ax=o[0]+v[i0]*s[0], ay=o[1]+v[i0+1]*s[1], az=o[2]+v[i0+2]*s[2];
    const bx=o[0]+v[i1]*s[0], by=o[1]+v[i1+1]*s[1], bz=o[2]+v[i1+2]*s[2];
    const cx=o[0]+v[i2]*s[0], cy=o[1]+v[i2+1]*s[1], cz=o[2]+v[i2+2]*s[2];
    const gx0=Math.max(0,((Math.min(ax,bx,cx)-x0)/cs)|0), gx1=((Math.max(ax,bx,cx)-x0)/cs)|0;
    const gy0=Math.max(0,((Math.min(ay,by,cy)-y0)/cs)|0), gy1=((Math.max(ay,by,cy)-y0)/cs)|0;
    /* 只登记「朝上」的面 —— 真正能站的地板和斜坡。
       碰撞网格是闭合体块：楼板有上下面、墙是竖直面，全都登记的话
       「该列最低面」会落到楼板内部（实测出生点就卡在板里，眼前一片实心），
       天花板也会被当成脚下的地面。朝下的面和竖直面一律跳过。 */
    const cx0=bx-ax, cy0=by-ay, cz0=bz-az, dx0=cx-ax, dy0=cy-ay, dz0=cz-az;
    const nz0 = cx0*dy0 - cy0*dx0;                 // 叉积的 z 分量（法线朝上为正）
    if(nz0 <= 0) continue;
    /* 按包围盒展开：大三角形中间的格子也得有地面，否则走到大平面中间会查空、掉下去。
       超大三角形（>50×50 格）展开代价高，退回只登记三个顶点所在的格。 */
    if((gx1-gx0+1)*(gy1-gy0+1) <= 2500){
      for(let gy=gy0; gy<=gy1; gy++) for(let gx=gx0; gx<=gx1; gx++){
        const key = gy*gw+gx;
        let a = cells.get(key); if(!a){ a = []; cells.set(key, a); }
        a.push(az, bz, cz);
      }
    } else {
      for(const [px,py,pz] of [[ax,ay,az],[bx,by,bz],[cx,cy,cz]]){
        const key = (((py-y0)/cs)|0)*gw + (((px-x0)/cs)|0);
        let a = cells.get(key); if(!a){ a = []; cells.set(key, a); }
        a.push(pz);
      }
    }
  }
  HFG = { x0, y0, cs, gw, cells };
}

/* 查 (x, z) 处的地面高度：
   优先取 refY+0.6m（台阶高）之下最高的面；脚下没面时向上找最近的面让调用者爬出去（限 climb）；
   refY<-1e8 = 直接取该列最低面（出生落地用）。没有地形或该列无面返回 null。 */
function groundAt(glx, glz, refY, climb){
  if(!HFG) return null;
  const gx = ((glx - HFG.x0)/HFG.cs)|0, gy = ((-glz - HFG.y0)/HFG.cs)|0;
  const a = HFG.cells.get(gy*HFG.gw+gx);
  if(!a) return null;
  const step = 0.6*UNITS_PER_M;
  let best = null, above = null;
  for(let i=0;i<a.length;i++){
    const z = a[i];
    if(z <= refY + step){ if(best === null || z > best) best = z; }
    else if(above === null || z < above) above = z;
  }
  if(refY < -1e8) return above;                       // 出生/落地：要最低面
  if(best !== null) return best;
  const cl = (climb === undefined) ? 1.2*UNITS_PER_M : climb;
  if(cl >= 0 && above !== null && above <= refY + step + cl) return above;
  return null;
}

function flySpeed(){ return mapSpan() * 0.45; }     // 基准飞行速度（单位/秒；原实现是 span(米)×0.45）

function flyMove(dt){
  const d = camDir();
  let rx = -d[2], rz = d[0];
  const rl = Math.hypot(rx, rz) || 1; rx/=rl; rz/=rl;
  if(CAM.walk){
    /* 行走：沿视线水平分量移动，贴地交给 groundSnap（固定步速，滚轮调速） */
    let fx = d[0], fz = d[2];
    const fl = Math.hypot(fx, fz) || 1; fx/=fl; fz/=fl;
    const sp = 18*UNITS_PER_M * CAM.wspd * dt * (FLYKEYS.has('shift') ? 2.2 : 1);
    let mx=0, mz=0;
    if(FLYKEYS.has('w')){ mx+=fx; mz+=fz; }
    if(FLYKEYS.has('s')){ mx-=fx; mz-=fz; }
    if(FLYKEYS.has('d')){ mx+=rx; mz+=rz; }
    if(FLYKEYS.has('a')){ mx-=rx; mz-=rz; }
    const l = Math.hypot(mx, mz);
    if(l){ CAM.ex += mx/l*sp; CAM.ez += mz/l*sp; }
    return;
  }
  const sp = flySpeed() * CAM.fspd * dt * (FLYKEYS.has('shift') ? 2.6 : 1);
  let mx=0,my=0,mz=0;
  if(FLYKEYS.has('w')){ mx+=d[0]; my+=d[1]; mz+=d[2]; }
  if(FLYKEYS.has('s')){ mx-=d[0]; my-=d[1]; mz-=d[2]; }
  if(FLYKEYS.has('d')){ mx+=rx; mz+=rz; }
  if(FLYKEYS.has('a')){ mx-=rx; mz-=rz; }
  if(FLYKEYS.has('e') || FLYKEYS.has(' ')) my+=1;
  if(FLYKEYS.has('q') || FLYKEYS.has('c')) my-=1;
  const l = Math.hypot(mx,my,mz);
  if(l){ CAM.ex += mx/l*sp; CAM.ey += my/l*sp; CAM.ez += mz/l*sp; }
}

/* 行走贴地：目标眼高 = 脚下地面 + 眼高；上坡/台阶快速上贴，下坡平滑下落 */
function groundSnap(dt){
  const eyeU = CAM.eyeH * UNITS_PER_M;
  const g = groundAt(CAM.ex, CAM.ez, CAM.ey - eyeU);
  if(g === null) return;
  CAM.wtgt = g + eyeU;
  const diff = CAM.wtgt - CAM.ey;
  if(diff > 0) CAM.ey += Math.min(diff, Math.max(diff*dt*14, dt*25*UNITS_PER_M));
  else CAM.ey += diff * Math.min(1, dt*14);
}

function flyTick(t){
  /* 没按键且贴地已收敛就停表，按键时再由 ensureFlyLoop 启动（省 CPU） */
  if(!CAM.free || S.mode !== '3d' ||
     (!FLYKEYS.size && Math.abs(CAM.ey - CAM.wtgt) < 0.02*UNITS_PER_M)){
    flyRaf = 0; return;
  }
  const dt = Math.min(0.1, (t - flyLast)/1000) || 0.016;
  flyMove(dt);
  if(CAM.walk) groundSnap(dt);
  render3D();
  /* 自适应分辨率：连续 30 帧平均 >24ms 降档 12.5%（最低 50%），<13ms 回升 —— 卡顿时保流畅 */
  perfAcc += dt; perfN++;
  if(perfN >= 30){
    const avg = perfAcc / perfN; perfAcc = 0; perfN = 0;
    if(avg > 0.024 && RSCALE > 0.5){ RSCALE = Math.max(0.5, RSCALE - 0.125); size3D(); }
    else if(avg < 0.013 && RSCALE < 1){ RSCALE = Math.min(1, RSCALE + 0.125); size3D(); }
  }
  flyLast = t;
  flyRaf = requestAnimationFrame(flyTick);
}
function ensureFlyLoop(){ if(!flyRaf){ flyLast = performance.now(); flyRaf = requestAnimationFrame(flyTick); } }

/* --- 模式切换：自由飞行 / 行走 --- */
function setFree(on){
  if(on === CAM.free || !cur) return;
  FLYKEYS.clear();          // 防止切换瞬间残留的移动键让相机「自己飘」
  if(on){
    const e = camEye();
    CAM.ex = e[0]; CAM.ey = e[1]; CAM.ez = e[2];
    CAM.free = true;
    ensureFlyLoop();
  } else {
    const d = camDir();
    CAM.tx = CAM.ex + d[0]*CAM.dist;
    CAM.ty = CAM.ey + d[1]*CAM.dist;
    CAM.tz = CAM.ez + d[2]*CAM.dist;
    CAM.free = false;
  }
  CAM.walk = false;
  syncCamUi();
  render3D();
}

function setWalk(on){
  if(on === CAM.walk || !cur) return;
  if(on && !HFG){ flashMsg('行走模式需要先加载地形（这张图本地没有地形分包）'); return; }
  if(on){
    if(!CAM.free){ const e0 = camEye(); CAM.ex=e0[0]; CAM.ey=e0[1]; CAM.ez=e0[2]; }
    CAM.free = true; CAM.walk = true;
    try{
      const w0 = parseFloat(localStorage.getItem('zmWalkSpd'));
      CAM.wspd = (w0 >= 0.25 && w0 <= 6) ? w0 : 1;      // 滚轮调速的记忆
    }catch(e){ CAM.wspd = 1; }
    /* 原地进入：直接取当前位置脚下的地面，不重置视角；悬空在无地形处才兜底落到该列最低面 */
    const g0 = groundAt(CAM.ex, CAM.ez, CAM.ey - CAM.eyeH*UNITS_PER_M, -1);
    if(g0 !== null){
      CAM.ey = g0 + CAM.eyeH*UNITS_PER_M; CAM.wtgt = CAM.ey;
      CAM.pitch = 0.08;                                  // 第一人称平视
    } else {
      walkDrop(true);
    }
    ensureFlyLoop();
  } else {
    CAM.walk = false;
    setFree(false);
    return;
  }
  syncCamUi();
}

/* 出生点：取「地形覆盖格子的重心」最近的有地面格。
   为什么不用实体包围盒的中心：那个包围盒含天空盒、灯探针之类，中心经常压根不在图里，
   从那儿开始走两步就出地形了（实测踩到过）。重心一定落在有图的区域上。 */
function spawnPoint(){
  if(!HFG) return null;
  let sx=0, sy=0, n=0;
  for(const [k, arr] of HFG.cells){
    if(!arr.length) continue;
    sx += k % HFG.gw; sy += (k / HFG.gw) | 0; n++;
  }
  if(!n) return null;
  const cx = Math.round(sx/n), cy = Math.round(sy/n);
  /* 在「三角形密集」的格子里挑离重心最近的那个：密集 = 真正的可走地面（大厅/主路），
     光取重心容易落到一块孤立的小结构上（实测出生后水平望去一片空）。 */
  let maxLen = 0;
  for(const [, arr] of HFG.cells) if(arr.length > maxLen) maxLen = arr.length;
  const busy = maxLen * 0.5;
  let best = null, bestD = Infinity;
  for(const [k, arr] of HFG.cells){
    if(arr.length < busy) continue;
    const gx = k % HFG.gw, gy = (k / HFG.gw) | 0;
    const d = (gx-cx)*(gx-cx) + (gy-cy)*(gy-cy);
    if(d < bestD){ bestD = d; best = { gx, gy, arr }; }
  }
  /* 一块密集格都没有（极端稀疏的图）就退回原来的「从重心向外找」 */
  if(best){
    let lo = best.arr[0];
    for(let i=1;i<best.arr.length;i++) if(best.arr[i] < lo) lo = best.arr[i];
    return { x: HFG.x0 + (best.gx+0.5)*HFG.cs, z: -(HFG.y0 + (best.gy+0.5)*HFG.cs), y: lo };
  }
  /* 从重心格向外一圈圈找最近的有地面格（最多 40 圈，约 80m） */
  for(let r=0; r<=40; r++){
    for(let dy=-r; dy<=r; dy++) for(let dx=-r; dx<=r; dx++){
      if(Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const arr = HFG.cells.get((cy+dy)*HFG.gw + (cx+dx));
      if(arr && arr.length){
        let lo = arr[0];
        for(let i=1;i<arr.length;i++) if(arr[i] < lo) lo = arr[i];
        return {
          x: HFG.x0 + (cx+dx+0.5)*HFG.cs,
          z: -(HFG.y0 + (cy+dy+0.5)*HFG.cs),
          y: lo,                         // 该列最低面 = 这格的底层地面
        };
      }
    }
  }
  return null;
}

/* lowest=true：落到该列最低面（出生兜底）；false：G 下穿 —— 排除当前层再往下找。
   楼板在碰撞网格里上下两面都有：掉落距离 <0.5m（落在板底）就继续往下穿，直到真正的下层地面。 */
function walkDrop(lowest){
  let g = null;
  if(lowest){
    g = groundAt(CAM.ex, CAM.ez, -1e9);
  } else {
    let probe = CAM.ey - CAM.eyeH*UNITS_PER_M, best = null;
    for(let i=0;i<8;i++){
      const g2 = groundAt(CAM.ex, CAM.ez, probe - 0.8*UNITS_PER_M, -1);
      if(g2 === null) break;
      best = g2;
      if(probe - g2 > 0.5*UNITS_PER_M) break;
      probe = g2;
    }
    g = best;
  }
  if(g === null){
    /* 当前位置没有地形（轨道相机退出来时眼睛常在图外）：挪到地形重心附近再落地 */
    const sp = spawnPoint();
    if(sp){ CAM.ex = sp.x; CAM.ez = sp.z; g = sp.y; }
  }
  if(g === null) return;
  CAM.ey = g + CAM.eyeH*UNITS_PER_M;
  CAM.wtgt = CAM.ey;
  if(CAM.walk){ render3D(); ensureFlyLoop(); }
}

/* 相机模式对应的界面状态 + 操作提示 */
function syncCamUi(){
  const fb = $('fly'), ob = $('orbit'), wb = $('walk');
  if(fb) fb.classList.toggle('on', CAM.free && !CAM.walk);
  if(ob) ob.classList.toggle('on', !CAM.free && !CAM.walk);
  if(wb) wb.classList.toggle('on', CAM.walk);
  const spd = $('fspdbox'); if(spd) spd.style.display = (CAM.free && !CAM.walk) ? '' : 'none';
  const sen = $('msensbox'); if(sen) sen.style.display = CAM.free ? '' : 'none';
  const eh = $('eyehbox'); if(eh) eh.style.display = CAM.walk ? '' : 'none';
  const keys = $('camkeys');
  if(keys) keys.innerHTML = CAM.walk
    ? '<span>WASD</span> 走 · <span>左键拖拽</span> 环顾 · <span>G</span> 下穿楼层 · <span>滚轮</span> 调速 · <span>Shift</span> 疾跑 · <span>V</span> 退出 · 无墙体碰撞'
    : CAM.free
      ? '<span>WASD</span> 移动 · <span>E/Q</span> 升/降 · <span>左键拖拽</span> 环顾 · <span>滚轮</span> 前后 · <span>移速</span> 面板滑杆 · <span>F</span> 退出'
      : '<span>左键拖拽</span> 旋转 · <span>右键/Shift</span> 平移 · <span>滚轮</span> 缩放 · <span>R</span> 复位 · <span>T</span> 俯视 · <span>V</span> 行走';
}

/* ============================ 工具 ============================ */
window.addEventListener('error', function(ev){
  var el = document.getElementById('lmsg');
  if(el) el.textContent = '运行错误：' + ev.message + ' @line ' + (ev.lineno||'?');
  document.title = 'ERR ' + ev.message;
});

window.addEventListener('unhandledrejection', function(ev){
  var r = ev.reason || {};
  var el = document.getElementById('lmsg');
  if(el) el.textContent = '异步错误：' + (r.message || r);
  document.title = 'ERR ' + (r.stack || r.message || r);
});

const $ = id => document.getElementById(id);
const fmt = n => n>=1e6 ? (n/1e6).toFixed(2)+'M' : n>=1e4 ? (n/1e3).toFixed(1)+'k' : n.toLocaleString();
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* 类别 → 图层 规则（与数据构建脚本一致，优先级从上到下） */
const RULES = [
  ["tele", ["trigger_teleport","trigger_teleport_relative","point_teleport","info_teleport_destination","trigger_teleport_autocancel"]],
  ["break",["func_breakable","func_breakable_surf","func_physbox","prop_physics","prop_physics_multiplayer","prop_physics_override","prop_physics_multiplayer_override","func_brush_breakable"]],
  ["hurt", ["trigger_hurt","env_fire","env_explosion","trigger_ignite","trigger_waterydeath"]],
  ["trig", ["trigger_once","trigger_multiple","trigger_push","func_buyzone","trigger_brush","trigger_wind","trigger_look","trigger_*","func_ladder","func_illusionary"]],
  ["mech", ["func_button","func_door","func_door_rotating","prop_door_rotating","func_movelinear","func_rotating","func_wall_toggle","func_tracktrain","phys_thruster","func_water","func_brush","func_wall","func_*"]],
  ["path", ["path_track","path_corner","func_trackautochange","path_*"]],
  ["logic",["logic_relay","logic_case","logic_timer","logic_branch","logic_auto","logic_compare","logic_measure_movement","logic_collision_pair","logic_multiple","logic_script","math_counter","math_remap","math_*","point_template","env_entity_maker","point_servercommand","game_player_equip","logic_*","point_*"]],
  ["spawn",["info_player_terrorist","info_player_counterterrorist","info_player_start","info_player_teamspawn","info_player_*"]],
  ["item", ["weapon_*","item_*","game_*"]],
  ["prop", ["prop_*","prop_dynamic","prop_static","prop_ragdoll"]],
  ["env",  ["light_*","info_particle_system","env_particle_glow","env_combined_light_probe_volume","env_light_probe_volume","env_cubemap_box","point_soundevent","ambient_generic","env_soundscape","env_soundscape_proxy","snd_event_point","env_sky","post_processing_volume","path_particle_rope_clientside","cable_dynamic","point_worldtext","env_fade","env_shake","env_hudhint","game_text","info_target","worldspawn","cs_minimap_boundary","func_clip_vphysics","filter_*","env_*","info_*","water_lod_control","sky_camera","shadow_control","color_correction"]]
];
const _exact = new Map(), _wild = [];
for(const [gid, pats] of RULES){ for(const p of pats){ if(p.endsWith('*')) _wild.push([p.slice(0,-1), gid]); else if(!_exact.has(p)) _exact.set(p, gid); } }
function gidOf(cn){
  const e = _exact.get(cn); if(e) return e;
  for(const [pre, gid] of _wild) if(cn.startsWith(pre)) return gid;
  return 'misc';
}

function proj(x,y,z){
  if(S.proj==='xy') return [x, -y];
  if(S.proj==='xz') return [x, -z];
  return [y, -z];
}

/* ============================ 侧栏 ============================ */
const entryOf = k => CATALOG ? CATALOG.maps.find(m => m.k === k) : null;
function buildSide(){
  if(!CATALOG) return;
  const q = $('q').value.trim().toLowerCase();
  const lm = S.listMode;
  let arr = CATALOG.maps.filter(m => !lm || m.a === lm);
  if(q) arr = arr.filter(m => (m.m+' '+m.cn+' '+m.i).toLowerCase().includes(q));
  const sk = S.sort;
  arr.sort((a,b)=> sk==='m' ? (a.cn||a.m).localeCompare(b.cn||b.m, 'zh-Hans-CN') :
                    sk==='st' ? (b.st-a.st)||(b.k2-a.k2) : (b.k2-a.k2));
  const box = $('maps');
  box.innerHTML = arr.slice(0,800).map(m=>
    `<div class="mi${m.k===S.key?' on':''}" data-k="${esc(m.k)}">
       <div class="mi-t">${esc(m.cn || m.m)}</div>
       <div class="mi-s">${esc(m.m)} · <b>${fmt(m.k2)}</b> 实体${m.st?` · ${m.st} 关`:''}</div>
     </div>`).join('') || '<div class="side-empty">无匹配地图</div>';
  const cnt = $('lcount');
  if(cnt) cnt.textContent = `${arr.length} 张`;
}

/* ============================ 载入某图 ============================ */
let cur = null;
function loadMap(k){
  S.key = k;
  const m = DATA.maps[k];
  m.__k = k;
  const b = S.full ? m.fb : m.b;
  cur = { m, b,
    pad:0.06,
    pts:[], grid:new Map(), cell:128, groups:{}, cncnt:{}, cnsize:{} };
  const gmap = {}; DATA.groups.forEach(g => gmap[g.id]=g);
  const clsG = CLS.map(c => gidOf(c));

  let xs=[],ys=[],zs=[];
  const bbT = m.bb, bbM = m.bbm;
  let eix = 0;
  for(const e of m.e){
    const gid = clsG[e[3]];
    const g = gmap[gid];
    if(!g) continue;
    const [px,py] = proj(e[0],e[1],e[2]);
    // 记录布局：[x,y,z,ci] + 可选 nm(string) / ai / gi，最后一位固定为关卡号（负值=就近推断）
    let nm=null, ai=-1, gi=-1, qp=4;
    if(typeof e[4]==='string'){ nm=e[4]; qp=5; }
    const end = e.length - 1;              // 最后一位 = sg
    if(end > qp){ ai = e[qp++]; }
    if(end > qp){ gi = e[qp]; }
    const sgr = e[end] || 0;
    const obj = {x:e[0],y:e[1],z:e[2],px,py,cn:CLS[e[3]],gid,nm:nm||'',ci:e[3],ai,gi,
                 sg:Math.abs(sgr), sgp:sgr<0};
    /* 实体包围盒表：每项为中心 XYZ + 半长 XYZ（原始值按 10 倍整数压缩）。
       没有包围盒的实体继续走 classname 典型尺寸回退。 */
    if(bbT && bbM && bbM[eix] >= 0){
      const q6 = bbM[eix] * 6;
      obj.bb = [bbT[q6]/10, bbT[q6+1]/10, bbT[q6+2]/10,
                bbT[q6+3]/10, bbT[q6+4]/10, bbT[q6+5]/10];
    }
    eix++;
    cur.pts.push(obj);
    cur.groups[gid] = (cur.groups[gid]||0)+1;
    cur.cncnt[gid] ||= {};
    cur.cncnt[gid][obj.cn] = (cur.cncnt[gid][obj.cn]||0)+1;
    cur.cnsize[gid] ||= {};
    const extent = obj.bb ? Math.max(obj.bb[3], obj.bb[4], obj.bb[5]) * 2 : 0;
    cur.cnsize[gid][obj.cn] = Math.max(cur.cnsize[gid][obj.cn]||0, extent);
    const cx = Math.floor(px/cur.cell), cy = Math.floor(py/cur.cell);
    const kk = cx+':'+cy;
    let arr = cur.grid.get(kk); if(!arr){arr=[];cur.grid.set(kk,arr);}
    arr.push(obj);
    xs.push(px); ys.push(py);
  }
  const w = Math.max(b[3]-b[0], b[5]-b[2], b[4]-b[1], 1);
  cur.span = Math.abs(maxOf(xs)-minOf(xs)) || 1;
  cur.spanY = Math.abs(maxOf(ys)-minOf(ys)) || 1;
  cur.cx = (maxOf(xs)+minOf(xs))/2; cur.cy = (maxOf(ys)+minOf(ys))/2;

  $('mtitle').textContent = m.cn || m.m;
  $('mcode').textContent = m.i + (m.f?(' · 版本 '+m.f):'');
  S.sel = null; $('edetail').style.display='none';
  $('esres').style.display='none'; $('esq').value='';
  S.stage = 0;
  buildStageSel();
  renderLayers(); renderStats(); fit();
  buildSide();
  loadRadar(m);
  build3D(); resetCam();
  if(S.mode==='3d') render3D();
  refreshTerrain();          // 地形是异步的：先按现状渲染，拉到了再补画
}
const minOf = a => a.length?Math.min.apply(null,a):0;
const maxOf = a => a.length?Math.max.apply(null,a):0;

/* ============================ 图层面板 ============================ */
function renderLayers(){
  const gmap={}; DATA.groups.forEach(g=>gmap[g.id]=g);
  const ids = Object.keys(cur.groups).sort((a,b)=>cur.groups[b]-cur.groups[a]);
  $('lbody').innerHTML = ids.map(id=>{
    const g = gmap[id]; if(!g) return '';
    const cns = Object.keys(cur.cncnt[id]||{}).sort((a,b)=>
      (cur.cnsize[id]?.[b]||0)-(cur.cnsize[id]?.[a]||0) || a.localeCompare(b, 'en'));
    const hidden = cns.filter(c=>S.coff.has(c));
    const visible = cur.groups[id] - hidden.reduce((n,c)=>n+cur.cncnt[id][c],0);
    const on = layerDrawn(id);
    const sub = S.xopen.has(id) && cns.length > 1 ? `<div class="subs">${cns.map(c=>{
      const off = S.coff.has(c);
      const size = cur.cnsize[id]?.[c]||0;
      return `<div class="si${off?' off':''}" data-g="${id}" data-cn="${esc(c)}" title="${off?'点击恢复显示':'点击隐藏该细类'}">
        <span class="sdot" style="background:${g.color}"></span><span class="snm">${esc(c)}</span>
        <span class="ct">${size?`${fmt(Math.round(size))}u · `:''}${fmt(cur.cncnt[id][c])}</span></div>`;
    }).join('')}</div>` : '';
    return `<div class="lwrap"><div class="li${on?'':' off'}${S.solo===id?' solo':''}" data-g="${id}">
      <span class="dot" style="background:${g.color}"></span>
      <span class="nm">${esc(g.label)}</span>
      <span class="ct"${hidden.length?` title="已隐藏 ${hidden.length} 个细类"`:''}>${fmt(visible)}</span>
      ${cns.length>1?`<span class="xbtn${S.xopen.has(id)?' open':''}" data-g="${id}" title="展开细类，可单独隐藏">${S.xopen.has(id)?'▾':'▸'}</span>`:''}
      </div>${sub}</div>`;
  }).join('');
  const shown = ids.filter(layerDrawn).length;
  $('lvis').textContent = ` ${shown}/${ids.length} 层`;
}

/**
 * 环境点在三维视图里**默认不画**（2026-10-05 反馈：「那些白点不要，为什么要出现」）。
 *
 * 它们是灯光、粒子、音效这类不参与玩法的实体，数量动辄几百上千；
 * 二维里它们组成「地形轮廓」密度底图，有意义；三维里叠在真实地形上只是密密麻麻的白点噪点。
 * 在图层面板点开「环境点」就会画（env3d = true），点了就按用户的意愿来。
 */
let env3d = false;
function layerDrawn(id){
  if(S.off.has(id)) return false;
  if(S.solo && S.solo !== id) return false;
  if(S.mode === '3d' && id === 'env' && !env3d) return false;
  return true;
}
function renderStats(){
  const m = cur.m;
  const order = ['tele','break','mech','hurt','trig','path'];
  const cnt = cur.groups;
  $('stats').innerHTML = [
    `<span class="chip">实体 <b>${fmt(m.n)}</b></span>`,
    `<span class="chip">可绘点 <b>${fmt(cur.pts.length)}</b></span>`,
    m.h ? `<span class="chip">抽样隐藏环境点 <b>${fmt(m.h)}</b></span>` : '',
    m.st ? `<span class="chip">看板关卡数 <b>${m.st}</b></span>` : '<span class="chip">看板无此图</span>',
    m.d ? `<span class="chip">工坊发布 <b>${esc(m.d)}</b></span>` : '',
    m.lib ? `<span class="chip">在云朵小铺地图库</span>` : '',
    ...order.filter(g=>cnt[g]).map(g=>{
      const gg = DATA.groups.find(x=>x.id===g);
      return `<span class="chip"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;
        background:${gg.color};margin-right:4px"></span>${gg.label} <b>${fmt(cnt[g])}</b></span>`;
    }),
    `<span class="chip">Top 类：${(m.t||[]).slice(0,5).map(x=>esc(x[0])+' <b>'+fmt(x[1])+'</b>').join(' · ')}</span>`
  ].filter(Boolean).join('');
}

/* ============================ 底图（雷达 / 密度轮廓） ============================ */
const radarCache = new Map();     // key -> ImageBitmap | null(加载中)
const densCache = new Map();      // key -> canvas | null

function drawBase(){
  if(!S.bmap || S.proj!=='xy' || !cur) return;
  const m = cur.m;
  const bmp = radarCache.get(S.key);
  if(m.rb && bmp){
    drawRadar(m, bmp);
  } else if(m.bg && bmp !== null){
    drawDensity(m);
  }
}
function worldRectScreen(){
  const b = cur.m.b;
  return { dx: sx(b[0]), dw: sx(b[3]) - sx(b[0]),
           dy: sy(-b[4]), dh: sy(-b[1]) - sy(-b[4]) };
}
function drawRadar(m, bmp){
  const bb = m.rbb || [0,0,1,1];
  const r = worldRectScreen();
  ctx.save();
  ctx.globalAlpha = S.bop;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, bb[0]*bmp.width, bb[1]*bmp.height,
                (bb[2]-bb[0])*bmp.width, (bb[3]-bb[1])*bmp.height, r.dx, r.dy, r.dw, r.dh);
  ctx.restore();
}
function drawDensity(m){
  let c = densCache.has(S.key) ? densCache.get(S.key) : undefined;
  if(c === undefined){
    c = buildDensityCanvas(m.bg);
    densCache.set(S.key, c);
  }
  if(!c) return;
  const r = worldRectScreen();
  ctx.save();
  ctx.globalAlpha = S.bop;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, r.dx, r.dy, r.dw, r.dh);
  ctx.restore();
}
function buildDensityCanvas(rec){
  try{
    const u8 = BIN.subarray(rec[0], rec[0] + rec[1]);
    const res = (DATA.meta && DATA.meta.bg_res) || 128;
    const cvs = document.createElement('canvas');
    cvs.width = res; cvs.height = res;
    const c2 = cvs.getContext('2d');
    const img = c2.createImageData(res, res);
    const d = img.data;
    // 4 级灰蓝地形填充（数据行序 = world y 升序 → 屏幕需上下翻转）
    const LV = [[0,0,0,0],[126,136,160,34],[106,118,146,70],[86,98,128,112]];
    for(let iy=0; iy<res; iy++){
      const dstRow = res-1-iy;
      for(let ix=0; ix<res; ix++){
        const i = iy*res+ix;
        const lv = (u8[i>>2] >> ((i&3)*2)) & 3;
        if(!lv) continue;
        const di = (dstRow*res+ix)*4;
        const c = LV[lv];
        d[di]=c[0]; d[di+1]=c[1]; d[di+2]=c[2]; d[di+3]=c[3];
      }
    }
    c2.putImageData(img, 0, 0);
    return cvs;
  }catch(e){ return null; }
}
function loadRadar(m){
  if(!m.rb || radarCache.has(S.key)){ draw(); return; }
  radarCache.set(S.key, null);
  try{
    const u8 = BIN.subarray(m.rb[0], m.rb[0] + m.rb[1]);
    createImageBitmap(new Blob([u8], {type:'image/webp'})).then(bmp=>{
      radarCache.set(S.key, bmp);
      draw();
    }).catch(()=>{ draw(); });
  }catch(e){ draw(); }
}

/* ============================ 画布 ============================ */
const cv = $('cv'), ctx = cv.getContext('2d');
let W=0,H=0,DPR=1;

function resize(){
  /* 手机上 DPR 常常是 3：2D 画布按 3 倍分配等于多画一倍多的像素，
     而地图库那种密集点云在手机上本来就是瓶颈，所以窄屏收敛到 2 倍。
     3D 那边在 size3D() 里另外有 RSCALE 动态降档。 */
  const dpr = window.devicePixelRatio || 1;
  DPR = window.innerWidth <= 820 ? Math.min(dpr, 2) : dpr;
  const r = cv.parentElement.getBoundingClientRect();
  W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
  cv.width = Math.round(W*DPR); cv.height = Math.round(H*DPR);
  ctx.setTransform(DPR,0,0,DPR,0,0);
  if(S.mode === '3d'){ render3D(); } else { draw(); }
}
window.addEventListener('resize', resize);

/* 键盘：R 复位 / T 俯视 / Esc 取消选中 */
window.addEventListener('keydown', e=>{
  const tag = (e.target.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'textarea') return;
  const k = e.key.toLowerCase();
  /* 行走/飞行时 WASD 等键要连续生效，攒进 FLYKEYS 交给 flyTick 按帧推进 */
  if(S.mode === '3d' && CAM.walk && k === 'g'){ walkDrop(false); ensureFlyLoop(); return; }
  if(S.mode === '3d' && CAM.free && ('wasdqec '.includes(k) || k === 'shift')){
    FLYKEYS.add(k);
    if(k === ' ') e.preventDefault();
    ensureFlyLoop();
    return;
  }
  if(k === 'r' && S.mode === '3d'){ if(CAM.free) setFree(false); resetCam(); render3D(); }
  else if(k === 't' && S.mode === '3d'){ if(CAM.free) setFree(false); topCam(); }
  else if(k === 'f' && S.mode === '3d'){
    if(CAM.walk){ CAM.walk = false; syncCamUi(); ensureFlyLoop(); }   // 行走 → 自由飞行：原地直接切
    else setFree(!CAM.free);
  }
  else if(k === 'v' && S.mode === '3d'){ setWalk(!CAM.walk); }
  else if(k === 'escape'){
    $('edetail').style.display='none';
    if(S.sel){ S.sel = null; build3D(); render3D(); draw(); }
  }
});
window.addEventListener('keyup', e=>{ FLYKEYS.delete((e.key || '').toLowerCase()); });
window.addEventListener('blur', ()=>{ FLYKEYS.clear(); });

function fit(){
  if(!W || !H){ setTimeout(fit, 60); return; }
  const b = cur.b;
  const p0 = proj(b[0], b[1], b[2]);
  const p1 = proj(b[3], b[4], b[5]);
  const sw = Math.max(1, Math.abs(p1[0]-p0[0])), sh = Math.max(1, Math.abs(p1[1]-p0[1]));
  view.s = Math.min(W/(sw*1.18), H/(sh*1.18));
  view.ox = W/2 - (p0[0]+p1[0])/2*view.s;
  view.oy = H/2 - (p0[1]+p1[1])/2*view.s;
  draw();
}
const sx = px => px*view.s + view.ox;
const sy = py => py*view.s + view.oy;

function draw(){
  ctx.clearRect(0,0,W,H);
  if(!cur) return;
  const gmap={}; DATA.groups.forEach(g=>gmap[g.id]=g);
  const zmin = cur.m.fb[2], zmax = cur.m.fb[5], zr = Math.max(1, zmax-zmin);

  drawBase();

  // 顺序：先大后小 / 高信号置顶
  const order = ['env','misc','prop','item','spawn','logic','path','mech','trig','hurt','break','tele'];
  const base = S.psize;

  if(S.glow){
    ctx.globalCompositeOperation = 'lighter';
    forEachDrawable(gmap, (o,g)=>{
      if(o.gid!=='env' && stageOk(o)){
        const g2 = ctx.createRadialGradient(sx(o.px),sy(o.py),0,sx(o.px),sy(o.py), base*9);
        g2.addColorStop(0, hexA(g.color,.13)); g2.addColorStop(1, hexA(g.color,0));
        ctx.fillStyle=g2;
        ctx.beginPath(); ctx.arc(sx(o.px),sy(o.py), base*9, 0, 6.2832); ctx.fill();
      }
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  for(const gid of order){
    const g = gmap[gid]; if(!g) continue;
    if(S.off.has(gid) || (S.solo && S.solo!==gid)) continue;
    const r = Math.max(0.7, base*(g.r||1));
    for(const o of cur.pts){
      if(o.gid!==gid) continue;
      if(!stageOk(o)) continue;
      ctx.fillStyle = S.hcol ? ramp((o.z-zmin)/zr) : g.color;
      ctx.beginPath(); ctx.arc(sx(o.px), sy(o.py), r, 0, 6.2832); ctx.fill();
    }
  }
  if(S.sel){
    const o = S.sel;
    ctx.strokeStyle = '#ff3d7f'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(sx(o.px), sy(o.py), Math.max(7, base*3.6), 0, 6.2832); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx(o.px)-10, sy(o.py)); ctx.lineTo(sx(o.px)+10, sy(o.py));
    ctx.moveTo(sx(o.px), sy(o.py)-10); ctx.lineTo(sx(o.px), sy(o.py)+10);
    ctx.stroke();
  }
  drawHud();
}
function forEachDrawable(gmap, fn){
  for(const o of cur.pts){
    const g = gmap[o.gid]; if(!g) continue;
    if(S.off.has(o.gid) || (S.solo && S.solo!==o.gid)) continue;
    if(S.coff.has(o.cn)) continue;
    if(!stageOk(o)) continue;
    fn(o,g);
  }
}
function hexA(h,a){
  const n = parseInt(h.slice(1),16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}
function ramp(t){
  t = Math.max(0, Math.min(1, t));
  const st = [[0.0,96,165,250],[0.35,52,211,153],[0.6,250,204,21],[0.8,251,146,60],[1.0,239,68,68]];
  for(let i=0;i<st.length-1;i++){
    const a=st[i], b=st[i+1];
    if(t>=a[0] && t<=b[0]){
      const u=(t-a[0])/(b[0]-a[0]||1);
      return `rgb(${Math.round(a[1]+(b[1]-a[1])*u)},${Math.round(a[2]+(b[2]-a[2])*u)},${Math.round(a[3]+(b[3]-a[3])*u)})`;
    }
  }
  return 'rgb(239,68,68)';
}
function drawHud(){
  $('zoomlab').textContent = Math.round(view.s*100)+'%';
  const want = 96/view.s;                      // 想要约 96px 的标尺
  const nice = [128,256,512,1024,2048,4096,8192,16384];
  let pick = nice[0];
  for(const n of nice) if(n<=want) pick=n;
  const px = pick*view.s;
  $('sbline').style.width = Math.max(20,px)+'px';
  $('sblab').textContent = pick>=1024 ? (pick/1024)+'k u' : pick+' u';
  $('north').style.display = S.proj==='xy' ? '' : 'none';
}

/* =====================================================================
   ★ 3D 视图：场景构建 / 相机 / 拾取 / 渲染
   ===================================================================== */
const cv3 = $('cv3');
let GLok = false, GLerr = '';

function init3D(){
  GLok = GL3D.init(cv3);
  if(!GLok){
    GLerr = window.__glerr || '浏览器没有提供 WebGL';
    const e = $('glerr');
    e.style.display = 'flex';
    e.innerHTML = '<div>⚠️ 3D 视图不可用：' + esc(GLerr) + '</div>' +
      '<div style="color:var(--ink3)">已自动切换到「平面」视图。请用较新的 Chrome / Edge 打开。</div>';
    setMode('2d');
    mark3DUnavailable(GLerr);
    return;
  }
  size3D();
}

/** 是不是 App 内置浏览器（微信 / QQ / 钉钉 / 微博 / 支付宝）：这些 WebView 常常不提供 WebGL */
function inAppBrowser(){
  const ua = navigator.userAgent || '';
  if(/MicroMessenger/i.test(ua)) return '微信';
  if(/\bQQ\/|QQBrowser/i.test(ua)) return 'QQ';
  if(/DingTalk/i.test(ua)) return '钉钉';
  if(/Weibo/i.test(ua)) return '微博';
  if(/Alipay/i.test(ua)) return '支付宝';
  return '';
}

/**
 * 3D 用不了时**让用户看得见原因**。
 * 以前这段话只写进 .stage3d 里的提示层，而那时已经切到平面视图、那层是 display:none ——
 * 结果就是「静默降级」：手机上打开只看到平面视图，完全不知道 3D 去哪了（2026-10-05 反馈）。
 * 现在改成两件事：右下角 toast 报原因，同时把「3D 视图」按钮打上 .off 标记（点它可重试）。
 * 内置浏览器（微信/QQ）单独给一句能照做的提示 —— 这类 WebView 是最常见的「没有 WebGL」来源。
 */
function mark3DUnavailable(reason){
  const app = inAppBrowser();
  const hint = app ? `${app}内置浏览器不提供 3D —— 点右上角「…」选「在浏览器打开」` : reason;
  const btn = document.querySelector('#mode button[data-m="3d"]');
  if(btn){
    btn.classList.add('off');
    btn.title = '3D 视图不可用：' + hint + '（点一下可重试）';
  }
  const bar = $('glwarn');
  if(bar){
    bar.hidden = false;
    $('glwarn-tx').innerHTML = '⚠️ 3D 视图不可用：' + esc(String(hint).slice(0, 160)) +
      '　<span style="opacity:.75">已切到平面视图，点「3D 视图」可重试</span>';
  }
  flashMsg('3D 视图不可用：' + hint + '。已切到平面视图，点「3D 视图」可重试', 9000);
}

/** 给反馈用的诊断文本（点「复制诊断」拿到的就是这一段） */
function glDiagnose(){
  let sup = '未知';
  try{
    const c = document.createElement('canvas');
    sup = ['webgl2', 'webgl', 'experimental-webgl']
      .map(k => k + '=' + (c.getContext(k) ? '有' : '无')).join(' ');
  }catch(e){ sup = '探测异常：' + e.message; }
  const cv = document.getElementById('cv3');
  const on = (id) => { const el = document.getElementById(id); return el ? (el.checked ? '开' : '关') : '无'; };
  return [
    'ZE 地图站 · 3D 诊断',
    'UA: ' + navigator.userAgent,
    '视口: ' + innerWidth + '×' + innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x',
    'WebGL 支持: ' + sup,
    '3D 画布: ' + (cv ? cv.width + '×' + cv.height : '没有') + ' · GLok=' + GLok,
    /* 场景里到底画了多少东西：把「看不见」拆成「没加载」还是「被关掉」 */
    '场景: 块体 ' + GL3D.boxCount + ' · 点云 ' + GL3D.ptCount + ' · 地形 ' + GL3D.meshCount + ' 面',
    '开关: 块体=' + on('vbox') + ' 地形=' + on('terbox') + ' 点云大小=' + Math.round((S.psz || 1) * 100) + '%' +
      ' 地形不透明度=' + Math.round((S.topa === undefined ? 1 : S.topa) * 100) + '%',
    '地形分片源: ' + terrBase + (terrBaseNote ? '（' + terrBaseNote + '）' : ''),
    'R2 域连通性: ' + (terrReach || '(未探测)'),
    '失败原因: ' + (window.__glerr || '(无记录)') + ' / ' + (GLerr || ''),
  ].join('\n');
}
$('glwarn-cp')?.addEventListener('click', async () => {
  const txt = glDiagnose();
  try{
    await navigator.clipboard.writeText(txt);
    flashMsg('诊断信息已复制，直接发给站长即可');
  }catch(e){
    /* 手机浏览器可能不给剪贴板权限：退回到「显示出来让用户手选」 */
    showDiag(txt);
  }
});
/* 图层浮层底部那行「场景诊断」：3D 正常时也能随时把现场数据调出来
   （看不见东西往往是「某一层没加载 / 被关掉」，光看画面判断不出来） */
function showDiag(txt){
  const bar = $('glwarn');
  if(!bar) return;
  bar.hidden = false;
  $('glwarn-tx').textContent = txt;
}
$('diaglink')?.addEventListener('click', (e) => {
  e.preventDefault();
  showDiag(glDiagnose());
});

/** 清掉「3D 不可用」标记（重试成功后） */
function clear3DUnavailable(){
  const btn = document.querySelector('#mode button[data-m="3d"]');
  if(btn){ btn.classList.remove('off'); btn.title = ''; }
  const e = $('glerr');
  if(e) e.style.display = 'none';
  const bar = $('glwarn');
  if(bar) bar.hidden = true;
  window.__glerr = '';
}

/* 手机切后台回来、显存吃紧时系统会回收 WebGL 上下文：画布变成一片黑、什么提示都没有。
   这里接住它，并在浏览器把上下文还回来时重建资源（program / buffer 都失效了，必须重新 init）。 */
cv3.addEventListener('webglcontextlost', e => {
  e.preventDefault();                 // 不 preventDefault 就不会有 restored 事件
  GLok = false;
  setMode('2d');                      // 先把可用视图给用户，别留一块黑画布
  mark3DUnavailable('图形上下文被系统回收（切后台常见）');
});
cv3.addEventListener('webglcontextrestored', () => {
  if(GL3D.init(cv3)){
    GLok = true;
    clear3DUnavailable();
    build3D();
    setMode('3d');
  }
});
function size3D(){
  const r = cv3.parentElement.getBoundingClientRect();
  const d = Math.min(window.devicePixelRatio || 1, 2);
  /* RSCALE：飞行/行走时若帧时间偏高会自动降档（见 flyTick），这里只负责按它分配绘制缓冲 */
  const w = Math.max(1, Math.round(r.width * d * RSCALE)), h = Math.max(1, Math.round(r.height * d * RSCALE));
  if(cv3.width !== w || cv3.height !== h){ cv3.width = w; cv3.height = h; }
}

/* 轻提示（行走模式缺地形之类的提醒） */
let toastT = 0;
function flashMsg(msg, ms = 2800){
  let el = $('toast');
  if(!el){
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('on'), ms);
}

/* --- 构建当前图的 3D 场景 --- */
let BOXES = [];
function build3D(){
  if(!GLok || !cur) return;
  const m = cur.m;
  const b = S.full ? m.fb : m.b;
  const gmap = {}; DATA.groups.forEach(g => gmap[g.id] = g);
  const clsG = CLS.map(c => gidOf(c));
  const half = DATA.clsHalf || [];
  const zLo = m.fb[2], zHi = m.fb[5], zR = Math.max(1, zHi - zLo);
  const cutZ = zLo + zR * S.cutz;        // 上剖切面
  const cutLo = zLo + zR * S.cutb;       // 下剖切面（0% = 不切）
  /* 覆盖全图/中心越界的巨型判定体积：默认不画，否则从外看会把整图实体块全遮住。
     合法的“大范围传送框”一般远小于地图半幅，不受影响。 */
  const fb = m.fb;
  const mapSpan = Math.max(fb[3] - fb[0], fb[4] - fb[1], fb[5] - fb[2]);
  const isGiant = (bb) => {
    const cx = bb[0], cy = bb[1], cz = bb[2], hx = bb[3], hy = bb[4], hz = bb[5];
    if (Math.max(hx, hy, hz) > 0.5 * mapSpan) return true;
    return cx < fb[0] - 1000 || cx > fb[3] + 1000 || cy < fb[1] - 1000 || cy > fb[4] + 1000 || cz < fb[2] - 1000 || cz > fb[5] + 1000;
  };

  const boxes = [];
  const parr = [];
  for(const o of cur.pts){
    /* 用 layerDrawn 而不是直接查 S.off：三维里「环境点」默认不画（见 layerDrawn 的说明） */
    if(!layerDrawn(o.gid)) continue;
    if(S.coff.has(o.cn)) continue;
    if(!stageOk(o)) continue;
    const g = gmap[o.gid]; if(!g) continue;
    const rgb = hex2rgb(S.hcol ? ramp((o.z - zLo) / zR) : g.color);
    // 高度剖切：只画 [cutLo, cutZ] 这一段（看内部触发区）
    if(o.gid !== 'env' && (o.z > cutZ || o.z < cutLo)) continue;

    if(o.gid === 'env' || o.gid === 'logic' || o.gid === 'misc' || o.gid === 'item' ||
       o.gid === 'spawn' || o.gid === 'prop') {
      // 轻量：用点精灵（世界 X=Source X，Y(上)=Source Z，Z=−Source Y）
      parr.push(o.x, o.z, -o.y, rgb[0]/255, rgb[1]/255, rgb[2]/255,
                o.gid === 'env' ? 0.55 : 1.0);
    } else {
      // 玩法实体：实体块（统一材质 + 类别色）· bsz = 块体大小倍率
     const h = half[o.ci] || [30,30,30];
      const bs = S.bsz;
      if(o.bb && !S.vbig && isGiant(o.bb)) continue;
     const center = o.bb ? [o.bb[0], o.bb[2], -o.bb[1]] : [o.x, o.z, -o.y];
     const ext = o.bb ? [o.bb[3]*bs, o.bb[5]*bs, o.bb[4]*bs]
                      : [h[0]*bs, h[2]*bs, h[1]*bs];
     const isSel = (S.sel === o);
     boxes.push({
       x:center[0], y:center[1], z:center[2],
       ex:ext[0], ey:ext[1], ez:ext[2],
        c: isSel ? [1.0,0.24,0.50] : [rgb[0]/255, rgb[1]/255, rgb[2]/255],
        a: isSel ? 1.0 : (o.gid === 'tele' ? S.bopa*0.72 : S.bopa),
        s: isSel,
        o: o,
      });
    }
  }
  if(!S.vbox) boxes.length = 0;
  BOXES = boxes;
  GL3D.setBoxes(boxes);
  GL3D.setPoints(new Float32Array(parr));
  $('v3info').innerHTML = `<b>${fmt(boxes.length)}</b> 块 · <b>${fmt(parr.length/7)}</b> 点`;
}
function hex2rgb(h){
  if(h[0] === '#'){
    const n = parseInt(h.slice(1), 16);
    return [(n>>16)&255, (n>>8)&255, n&255];
  }
  const m = h.match(/(\d+)\D+(\d+)\D+(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : [150,150,150];
}
/* 关卡下拉：从当前图的实体里收集关卡号，并记录每关包围盒（用于选中后聚焦） */
let stageBounds = null;
function buildStageSel(){
  const sel = $('stagesel');
  const st = new Set();
  stageBounds = {};
  if(cur) for(const o of cur.pts){
    if(!o.sg) continue;
    st.add(o.sg);
    let b = stageBounds[o.sg];
    if(!b) stageBounds[o.sg] = [o.x, o.y, o.z, o.x, o.y, o.z];
    else {
      if(o.x<b[0])b[0]=o.x; if(o.y<b[1])b[1]=o.y; if(o.z<b[2])b[2]=o.z;
      if(o.x>b[3])b[3]=o.x; if(o.y>b[4])b[4]=o.y; if(o.z>b[5])b[5]=o.z;
    }
  }
  const arr = [...st].sort((a,b)=>a-b);
  let html = '<option value="0">全部（' + (cur ? fmt(cur.pts.length) : 0) + ' 个实体）</option>';
  for(const n of arr){
    const c = cur.pts.reduce((a,o)=>a+(o.sg===n?1:0), 0);
    html += `<option value="${n}">第 ${n} 关（${fmt(c)}）</option>`;
  }
  if(arr.length) html += '<option value="-1">未标注关卡</option>';
  sel.innerHTML = html;
  sel.value = '0';
  $('rowsg').style.display = arr.length ? '' : 'none';
}
/* 选中关卡后把视角聚焦到该关区域 */
function focusStage(){
  if(!cur) return;
  const b = (S.stage > 0 && stageBounds) ? stageBounds[S.stage] : null;
  if(!b){
    if(S.mode === '3d'){ resetCam(); render3D(); } else fit();
    return;
  }
  const x0=b[0], y0=b[1], z0=b[2], x1=b[3], y1=b[4], z1=b[5];
  if(S.mode === '3d'){
    CAM.tx = (x0+x1)/2; CAM.ty = (z0+z1)/2; CAM.tz = -(y0+y1)/2;
    const span = Math.max(x1-x0, y1-y0, z1-z0, 256);
    CAM.dist = Math.max(300, span * 1.5);
    CAM.fogK = 0.22 / Math.max(span * 2.2, 600);
    render3D();
  } else {
    const p0 = proj(x0,y0,z0), p1 = proj(x1,y1,z1);
    const sw = Math.max(1, Math.abs(p1[0]-p0[0])), sh = Math.max(1, Math.abs(p1[1]-p0[1]));
    view.s = Math.min(W/(sw*1.35), H/(sh*1.35));
    view.ox = W/2 - (p0[0]+p1[0])/2*view.s;
    view.oy = H/2 - (p0[1]+p1[1])/2*view.s;
    draw();
  }
}
/* 复位相机：按包围盒自适应 */
function resetCam(){
  if(!cur) return;
  const b = S.full ? cur.m.fb : cur.m.b;
  const x0 = Math.min(b[0], b[3]), x1 = Math.max(b[0], b[3]);
  const y0 = Math.min(b[1], b[4]), y1 = Math.max(b[1], b[4]);
  const z0 = Math.min(b[2], b[5]), z1 = Math.max(b[2], b[5]);
  CAM.tx = (x0 + x1) / 2;
  CAM.tz = -(y0 + y1) / 2;
  CAM.ty = (z0 + z1) / 2;
  const span = Math.max(x1-x0, y1-y0, z1-z0, 256);
  CAM.dist = span * 1.30;
  CAM.span = span;
  CAM.yaw = -Math.PI/2; CAM.pitch = 0.62;
  CAM.fogK = 0.22 / span;
  if(CAM.free){
    const cp = Math.cos(CAM.pitch), sp = Math.sin(CAM.pitch);
    CAM.ex = CAM.tx + CAM.dist*cp*Math.cos(CAM.yaw);
    CAM.ey = CAM.ty + CAM.dist*sp;
    CAM.ez = CAM.tz + CAM.dist*cp*Math.sin(CAM.yaw);
  }
  CAM.ready = true;
}
function topCam(){
  CAM.yaw = -Math.PI/2; CAM.pitch = Math.PI/2 - 0.001;
  render3D();
}

/* --- 3D 渲染 --- */
function render3D(){
  if(!GLok || !cur) return;
  size3D();
  const { eye, vp } = camVP();
  GL3D.setVP(vp);
  /* 剖切面：和 build3D() 用同一个口径（Source Z 坐标，保留 [cutb, cutz] 这一段） */
  const bb = cur.m.fb;
  const zR = Math.max(1, bb[5] - bb[2]);
  const cutZ = bb[2] + zR * S.cutz;
  const cutLo = bb[2] + zR * S.cutb;
  GL3D.draw({
    vp, eye,
    alpha: 1.0,
    /* 点云点径。着色器里算的是 gl_PointSize = aSz * uPx / 距离，
       而本站的 aSz 只是「1.0 / 环境点 0.55」这种倍率（不是世界尺寸），
       所以 uPx 得自己把「世界直径」换算成屏幕像素：
         px = 直径 · (1/tan(fovy/2)) · (视口高度/2)，fovy=45° → 系数 1.207
       并且要用**帧缓冲**高度（DPR / RSCALE 之后），因为 gl_PointSize 的单位是设备像素。
       以前这里写的是 W/700（约等于 2），算下来恒被 clamp 到 1px ——
       「把块体隐藏后就看不见任何东西」（2026-10-05 反馈）就是这个原因：
       白点（环境点）其实一直在画，只是每个点只有 1 个设备像素。 */
    px: pointDot() * (1 / Math.tan(45 * Math.PI / 360)) * 0.5 * (cv3.height || H) * S.psz,
    pAlpha: 0.85,
    solid: S.vbox,
    fogK: CAM.fogK, fog: CAM.fog,
    terrain: S.terrain,
    topa: S.topa,                  // 地形不透明度（拉低可透视内部）
    cutY: cutZ,
    cutLo: cutZ >= bb[5] - 0.5 && cutLo <= bb[2] + 0.5 ? -1e9 : cutLo,
  });
  drawGrid(vp);
  drawAxis();
}
/* 点的世界直径：随图幅缩放（大图/小图的观感才一致）。
   0.005 = 图幅的千分之五：3 万单位的图约 150 单位，默认机位下约 5 个设备像素；
   环境点还有 0.55 的倍率（aSz），实际约 3 像素 —— 和平面视图里那些白点的分量相当。
   嫌小可以拉图层面板里的「点云」滑杆（20%~250%）。 */
function pointDot(){
  return mapSpan() * 0.005;
}

/* 地面网格 + 高度参考框（帮助建立三维空间感） */
function drawGrid(vp){
  const b = S.full ? cur.m.fb : cur.m.b;
  const x0 = Math.min(b[0], b[3]), x1 = Math.max(b[0], b[3]);
  const y0 = Math.min(b[1], b[4]), y1 = Math.max(b[1], b[4]);
  const z0 = Math.min(b[2], b[5]), z1 = Math.max(b[2], b[5]);
  const span = Math.max(x1-x0, y1-y0, z1-z0, 1);
  let step = Math.pow(10, Math.round(Math.log10(span/10)));
  if(span/step > 18) step *= 2;
  const gx0 = Math.floor(x0/step)*step, gx1 = Math.ceil(x1/step)*step;
  const gy0 = Math.floor(y0/step)*step, gy1 = Math.ceil(y1/step)*step;
  const arr = [];
  // z 轴朝上 → 世界 Y = Source Z
  const gy = z0;
  const cA = [0.80,0.82,0.87], cB = [0.72,0.74,0.80];
  for(let x = gx0; x <= gx1 + 1e-6; x += step){
    arr.push(x, gy, -y0, cB[0],cB[1],cB[2], x, gy, -y1, cB[0],cB[1],cB[2]);
  }
  for(let y = gy0; y <= gy1 + 1e-6; y += step){
    arr.push(x0, gy, -y, cB[0],cB[1],cB[2], x1, gy, -y, cB[0],cB[1],cB[2]);
  }
  // 高度范围竖直参考线（四角）
  const zt = z1;
  const corners = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  for(const [cx, cy] of corners){
    arr.push(cx, gy, -cy, cA[0],cA[1],cA[2], cx, zt, -cy, cA[0],cA[1],cA[2]);
  }
  GL3D.drawLines(new Float32Array(arr), 0.42);
}
/* 右上角方位指示（X/Y 轴 + 高度轴） */
function drawAxis(){
  const c = $('axis'), g = c.getContext('2d');
  const W2 = c.width, H2 = c.height, R = 44;
  g.clearRect(0,0,W2,H2);
  const eye = camEye();
  const dirs = [
    {v:[1,0,0], t:'X', col:'#ef4444'},
    {v:[0,0,-1], t:'Y', col:'#22c55e'},
    {v:[0,1,0], t:'Z', col:'#3b82f6'},
  ];
  // 简单正交投影：用相机方向做基
  const f = [CAM.tx-eye[0], CAM.ty-eye[1], CAM.tz-eye[2]];
  const fl = Math.hypot(...f) || 1; const fw = f.map(x=>x/fl);
  let rt = [fw[2], 0, -fw[0]]; const rl = Math.hypot(...rt) || 1; rt = rt.map(x=>x/rl);
  const up = [rt[1]*fw[2]-rt[2]*fw[1], rt[2]*fw[0]-rt[0]*fw[2], rt[0]*fw[1]-rt[1]*fw[0]];
  g.lineWidth = 3;
  g.lineCap = 'round';
  for(const d of dirs){
    const x = d.v[0]*rt[0] + d.v[1]*rt[1] + d.v[2]*rt[2];
    const y = d.v[0]*up[0] + d.v[1]*up[1] + d.v[2]*up[2];
    const sx2 = W2/2 + x*R, sy2 = H2/2 - y*R;
    g.strokeStyle = d.col; g.beginPath();
    g.moveTo(W2/2, H2/2); g.lineTo(sx2, sy2); g.stroke();
    g.fillStyle = d.col; g.font = 'bold 22px sans-serif';
    g.textAlign='center'; g.textBaseline='middle';
    g.fillText(d.t, W2/2 + x*(R+13), H2/2 - y*(R+13));
  }
}

/* --- 3D 交互 ---
 *
 * 触屏（2026-10-05 补）：单指旋转、双指捏合缩放、双指拖动平移。
 * 以前只有 wheel 缩放、右键/Shift 平移 —— 手机上这两个都够不着，
 * 触屏用户进 3D 只能转视角，既不能缩放也不能平移。
 * 双指手势的换算与滚轮/右键保持一致：捏合 = 改 dist（自由视角改沿视线推拉），
 * 拖动中点 = 屏幕平移 → 世界平移。
 */
let drag3 = null;
const pts3 = new Map();     // pointerId -> {x,y}：用来分辨单指 / 双指
let pinch3 = null;          // 双指手势的起始快照（缩放平移都从它算起，避免累积漂移）
let multi3 = false;         // 这一段触摸出现过双指 → 抬手时不要当成「点选实体」

/** 屏幕平移 → 世界平移（单指右键拖动与双指拖动共用） */
function pan3(dx, dy, from){
  const eye = camEye();
  const d = camDir();
  if(CAM.free){
    /* 自由视角：直接平移眼睛，不挪轨道目标点。
       右向量 / 上向量 / 系数都照软件的取法（rt = [-dz, 0, dx]，k = span/H*0.85），
       用轨道那一套会让拖动方向反掉。 */
    let rt = [-d[2], 0, d[0]];
    const rl = Math.hypot(rt[0], rt[2]) || 1; rt = [rt[0]/rl, 0, rt[2]/rl];
    const up = [-rt[2]*d[1], rt[2]*d[0]-rt[0]*d[2], rt[0]*d[1]];
    const k = mapSpan() / Math.max(1, H) * 0.85;
    CAM.ex = from.ex - (rt[0]*dx - up[0]*dy) * k;
    CAM.ey = from.ey - (rt[1]*dx - up[1]*dy) * k;
    CAM.ez = from.ez - (rt[2]*dx - up[2]*dy) * k;
  } else {
    // 轨道视角：屏幕平移 → 世界平移（沿相机右向 / 上向）
    const f = [CAM.tx-eye[0], CAM.ty-eye[1], CAM.tz-eye[2]];
    const fl = Math.hypot(...f)||1; const fw = f.map(x=>x/fl);
    let rt = [fw[2], 0, -fw[0]]; const rl = Math.hypot(...rt)||1; rt = rt.map(x=>x/rl);
    const up = [rt[1]*fw[2]-rt[2]*fw[1], rt[2]*fw[0]-rt[0]*fw[2], rt[0]*fw[1]-rt[1]*fw[0]];
    const k = CAM.dist / Math.max(1, H) * 1.4;
    CAM.tx = from.tx - (rt[0]*dx - up[0]*dy) * k;
    CAM.ty = from.ty - (rt[1]*dx - up[1]*dy) * k;
    CAM.tz = from.tz - (rt[2]*dx - up[2]*dy) * k;
  }
}

/** 双指捏合：ratio > 1 = 放大。轨道视角改相机距离，自由视角沿视线推拉（与滚轮同义） */
function pinchZoom3(ratio){
  if(CAM.walk) return;                       // 行走模式没有缩放这一说
  if(CAM.free){
    const d = camDir();
    const st = flySpeed() * CAM.fspd * 0.9 * (ratio - 1);
    CAM.ex = pinch3.start.ex + d[0]*st;
    CAM.ey = pinch3.start.ey + d[1]*st;
    CAM.ez = pinch3.start.ez + d[2]*st;
  } else {
    CAM.dist = Math.max(40, Math.min(60000, pinch3.start.dist / ratio));
  }
}

cv3.addEventListener('contextmenu', e => e.preventDefault());
cv3.addEventListener('pointerdown', e => {
  if(!GLok) return;
  cv3.setPointerCapture(e.pointerId);
  pts3.set(e.pointerId, { x:e.clientX, y:e.clientY });
  cv3.classList.add('grabbing');

  if(pts3.size === 2){
    const [p, q] = [...pts3.values()];
    multi3 = true;
    drag3 = null;                            // 双指期间不再转头
    pinch3 = { d: Math.hypot(p.x-q.x, p.y-q.y) || 1,
               mid: { x:(p.x+q.x)/2, y:(p.y+q.y)/2 },
               start: { dist:CAM.dist, tx:CAM.tx, ty:CAM.ty, tz:CAM.tz,
                        ex:CAM.ex, ey:CAM.ey, ez:CAM.ez } };
    return;
  }
  if(pts3.size > 2) return;

  /* 鼠标：右键 / Shift = 平移；触屏：单指一律旋转（双指才平移） */
  drag3 = { x:e.clientX, y:e.clientY, yaw:CAM.yaw, pitch:CAM.pitch,
            tx:CAM.tx, ty:CAM.ty, tz:CAM.tz,
            ex:CAM.ex, ey:CAM.ey, ez:CAM.ez,        // 自由视角平移要用
            pan: (e.button === 2 || e.shiftKey) };
});
function endPtr3(e){
  pts3.delete(e.pointerId);
  if(pts3.size < 2) pinch3 = null;
  if(pts3.size === 1 && multi3){
    /* 双指里抬起一根手指：剩下的那根接着转视角（不然手感像「卡住了」）。
       注意这里不清 multi3 —— 这一段触摸仍然是双指手势，最后抬手不该触发点选。 */
    const [p] = [...pts3.values()];
    drag3 = { x:p.x, y:p.y, yaw:CAM.yaw, pitch:CAM.pitch,
              tx:CAM.tx, ty:CAM.ty, tz:CAM.tz,
              ex:CAM.ex, ey:CAM.ey, ez:CAM.ez, pan:false };
    return;
  }
  if(pts3.size > 0) return;

  cv3.classList.remove('grabbing');
  if(drag3){
    /* 手指点按会抖几像素，触屏的判定阈值放宽一些，否则「想选中实体」会变成没反应 */
    const tol = e.pointerType === 'mouse' ? 4 : 12;
    const moved = Math.abs(e.clientX-drag3.x) + Math.abs(e.clientY-drag3.y);
    if(moved < tol && !drag3.pan && !multi3) pick3(e);
  }
  drag3 = null;
  multi3 = false;
}
cv3.addEventListener('pointerup', endPtr3);
cv3.addEventListener('pointercancel', endPtr3);
cv3.addEventListener('pointermove', e => {
  if(pts3.has(e.pointerId)) pts3.set(e.pointerId, { x:e.clientX, y:e.clientY });

  /* 双指：捏合缩放 + 中点位移平移 */
  if(pinch3 && pts3.size >= 2){
    const [p, q] = [...pts3.values()];
    const d = Math.hypot(p.x-q.x, p.y-q.y) || 1;
    const mid = { x:(p.x+q.x)/2, y:(p.y+q.y)/2 };
    pinchZoom3(d / pinch3.d);
    /* 平移用「手势起点的轨道参数 + 当前的眼睛位置」：自由视角的缩放会改眼睛，
       若两者都用起点快照，后一步会把前一步覆盖掉。 */
    pan3(mid.x - pinch3.mid.x, mid.y - pinch3.mid.y,
         { tx:pinch3.start.tx, ty:pinch3.start.ty, tz:pinch3.start.tz,
           ex:CAM.ex, ey:CAM.ey, ez:CAM.ez });
    render3D();
    return;
  }

  if(!drag3) return;
  const dx = e.clientX - drag3.x, dy = e.clientY - drag3.y;
  if(drag3.pan){
    pan3(dx, dy, drag3);
  } else {
    /* 转头方向两种模式符号相反（软件里就是这么分的）：
       自由视角 = FPS 惯例（右拖右看），轨道视角 = 抓住世界拖（场景跟随光标）。 */
    const sens = CAM.free ? CAM.msens : 1;
    CAM.yaw = CAM.free ? drag3.yaw + dx * 0.008 * sens
                       : drag3.yaw - dx * 0.008;
    CAM.pitch = Math.max(-1.52, Math.min(1.52, drag3.pitch + dy * 0.008 * sens));
  }
  render3D();
});
cv3.addEventListener('wheel', e => {
  e.preventDefault();
  if(CAM.walk){
    /* 行走：滚轮调速（0.25~6x，记忆） */
    CAM.wspd = Math.max(0.25, Math.min(6, CAM.wspd * (e.deltaY < 0 ? 1.15 : 1/1.15)));
    try{ localStorage.setItem('zmWalkSpd', CAM.wspd); }catch(err){}
    flashMsg('行走速度 ' + CAM.wspd.toFixed(2) + '×');
    return;
  }
  if(CAM.free){
    /* 自由飞行：滚轮沿视线前后移动 */
    const d = camDir();
    const st = flySpeed() * CAM.fspd * (e.deltaY < 0 ? 0.12 : -0.12);
    CAM.ex += d[0]*st; CAM.ey += d[1]*st; CAM.ez += d[2]*st;
    render3D();
    return;
  }
  CAM.dist = Math.max(40, Math.min(60000, CAM.dist * (e.deltaY < 0 ? 1/1.13 : 1.13)));
  render3D();
}, {passive:false});

/* 3D 拾取：把所有块投影到屏幕，取最近命中 */
function pick3(e){
  if(!cur) return;
  const r = cv3.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const { vp } = camVP();
  const eye = camEye();
  let best = null, bd = 1e18;
  const lim = 13;
  for(const bo of BOXES){
    const p = projPt(vp, bo.x, bo.y, bo.z);
    if(!p) continue;
    const d = Math.hypot(p[0]-mx, p[1]-my);
    if(d > lim) continue;
    const dd = Math.hypot(bo.x-eye[0], bo.y-eye[1], bo.z-eye[2]);
    if(d < lim && dd < bd){ bd = dd; best = bo; }
  }
  if(best){
    const o = best.o;
    if(o){ selectEnt(o, false); build3D(); render3D(); }
  } else {
    $('edetail').style.display='none';
    if(S.sel){ S.sel = null; build3D(); render3D(); }
  }
}
function projPt(vp, x, y, z){
  const w = vp[3]*x + vp[7]*y + vp[11]*z + vp[15];
  if(w <= 0.001) return null;
  const cx = (vp[0]*x + vp[4]*y + vp[8]*z + vp[12]) / w;
  const cy = (vp[1]*x + vp[5]*y + vp[9]*z + vp[13]) / w;
  return [(cx*0.5+0.5)*W, (0.5-cy*0.5)*H];
}

function setMode(m){
  /* 3D 之前初始化失败过：用户点「3D 视图」时再试一次。
     有的浏览器要等一次用户手势，有的只是上下文被回收后恢复了 —— 试一次很便宜，
     失败才提示原因（以前是点了完全没反应）。 */
  if(m === '3d' && !GLok){
    const ctx = cv3.getContext('webgl2') || cv3.getContext('webgl');
    if(ctx && ctx.isContextLost && ctx.isContextLost()){
      flashMsg('图形上下文还没恢复，稍等再点一次或刷新页面', 5000);
      return;
    }
    if(GL3D.init(cv3)){ GLok = true; clear3DUnavailable(); build3D(); }
    else { mark3DUnavailable(window.__glerr || '浏览器没有提供 WebGL'); return; }
  }
  S.mode = m;
  [].forEach.call($('mode').children, b => b.classList.toggle('on', b.dataset.m === m));
  const is3 = m === '3d' && GLok;
  $('stage3d').classList.toggle('on', is3);
  cv.style.display = is3 ? 'none' : 'block';
  // 2D 专属控件在 3D 下隐藏：投影切换 / 高度着色 / 点径 / 光晕 / 底图行 / 2D HUD
  $('proj').style.display = is3 ? 'none' : '';
  $('broww').style.display = is3 ? 'none' : '';
  document.querySelectorAll('.ctl').forEach(el => {
    const id = el.querySelector('input') && el.querySelector('input').id;
    el.style.display = (is3 && (id === 'psize' || id === 'glow' || id === 'full' || id === 'hcol'))
      ? 'none' : '';
  });
  document.querySelector('.hud').style.display = is3 ? 'none' : '';
  // 3D 专属行（统一用 .row3d 标记，新增设置项不用再改这里）
  document.querySelectorAll('.row3d').forEach(el => { el.style.display = is3 ? '' : 'none'; });
  if(is3){ render3D(); }
  else { resize(); }
  // 回平面视图就退出自由/行走（那两个只在 3D 下有意义，留着会让滑杆在 2D 里显形）
  if(!is3 && CAM.free){ CAM.walk = false; setFree(false); }
  refreshTerrain();   // 进 3D 时按需拉地形；回 2D 时把网格释放掉
}

/* ============================ 实体选中 / 详情 / 搜索 ============================ */
function groupColor(gid){
  const g = DATA.groups.find(x=>x.id===gid);
  return g ? g.color : '#999';
}
function selectEnt(o, focus){
  S.sel = o;
  showDetail(o);
  if(focus){
    if(S.mode === '3d'){
      // 3D：把相机目标移到实体上，并拉近
      CAM.tx = o.x; CAM.ty = o.z; CAM.tz = -o.y;
      CAM.dist = Math.max(220, Math.min(CAM.dist, (cur && cur.m ? Math.max(1, (cur.m.fb[5]-cur.m.fb[2])) : 400) * 1.1));
      build3D(); render3D();
      return;
    }
    if(view.s < 1.4) view.s = 1.4;
    view.ox = W/2 - o.px*view.s;
    view.oy = H/2 - o.py*view.s;
  }
  draw();
  if(S.mode === '3d'){ build3D(); render3D(); }
}
/* 属性 / 连线在数据构建期就已解析成可读文本，这里直接用：
 *   A2[i] = [[键名, 值], ...]        C2[i] = [[输出, 目标, 输入, 参数, 延迟], ...]
 */
function showDetail(o){
  const m = cur.m;
  let html = `<h5><span style="display:inline-block;width:9px;height:9px;border-radius:50%;
      background:${groupColor(o.gid)}"></span>${esc(o.cn)}
      <span class="close" id="edclose">✕</span></h5>`;
  if(o.nm) html += `<div class="dtx">名称 <b>${esc(o.nm)}</b></div>`;
  html += `<div class="dtx">坐标 <b>${Math.round(o.x)}, ${Math.round(o.y)}, ${Math.round(o.z)}</b> · 高度 ${Math.round(o.z)}</div>`;
  if(o.sg) html += `<div class="dtx">所属关卡 <b style="color:#d4547e">第 ${o.sg} 关</b>${o.sgp?'<span style="color:var(--ink3)">（按就近推断）</span>':''}</div>`;
  const attrs = (o.ai>=0 && m.A2 && m.A2[o.ai]) || [];
  if(attrs.length){
    html += `<div class="sec">属性</div><table>` +
      attrs.map(a=>`<tr><td>${esc(a[0])}</td><td><b>${esc(String(a[1]))}</b></td></tr>`).join('') +
      `</table>`;
  }
  const cxs = (o.gi>=0 && m.C2 && m.C2[o.gi]) || [];
  if(cxs.length){
    html += `<div class="sec">触发连接 ${cxs.length} 条</div>` + cxs.map(c=>
      `<div class="cx"><b>${esc(c[0])}</b> → ${esc(c[1])} : ${esc(c[2])}` +
      (c[3]?` <span style="color:var(--ink3)">（${esc(c[3])}）</span>`:'') +
      (c[4]!==0&&c[4]!==''&&c[4]!=null?` <span style="color:var(--ink3)">延迟 ${esc(String(c[4]))}s</span>`:'') +
      `</div>`).join('');
  }
  if(!attrs.length && !cxs.length){
    html += `<div class="dtx" style="margin-top:6px;color:var(--ink3)">该实体无附加属性 / 连接记录</div>`;
  }
  const el = $('edetail');
  el.innerHTML = html;
  el.style.display = 'block';
  $('edclose').onclick = ()=>{ el.style.display='none'; S.sel=null; draw(); };
}
/* 实体搜索 */
function esRender(){
  const q = $('esq').value.trim().toLowerCase();
  const box = $('esres');
  if(!q || !cur){ box.style.display='none'; box.__hits=null; return; }
  const hits = [];
  for(const o of cur.pts){
    if(S.coff.has(o.cn)) continue;
    if((o.nm && o.nm.toLowerCase().includes(q)) || o.cn.toLowerCase().includes(q)){
      hits.push(o);
      if(hits.length>=60) break;
    }
  }
  hits.sort((a,b)=>(b.nm?1:0)-(a.nm?1:0));
  box.innerHTML = hits.length
    ? hits.map((o,i)=>`<div class="esr" data-i="${i}">
        <span class="dot" style="background:${groupColor(o.gid)}"></span>
        <span class="en">${esc(o.nm||o.cn)}</span>
        <span class="ec">${esc(o.cn)}${o.sg?' · S'+o.sg:''}${o.nm?' · ['+Math.round(o.x)+', '+Math.round(o.y)+', '+Math.round(o.z)+']':''}</span>
      </div>`).join('')
    : '<div class="esr"><span class="ec">当前地图无匹配实体</span></div>';
  box.__hits = hits;
  box.style.display = 'block';
}
$('esq').addEventListener('input', esRender);
$('esq').addEventListener('keydown', e=>{ if(e.key==='Escape'){ $('esres').style.display='none'; } });
$('esres').addEventListener('click', e=>{
  const r = e.target.closest('.esr');
  if(!r || r.dataset.i===undefined || !$('esres').__hits) return;
  const o = $('esres').__hits[+r.dataset.i];
  if(!o) return;
  $('esres').style.display='none';
  selectEnt(o, true);
});

/* ============================ 交互 ============================
 *
 * 2D 视图统一走 pointer 事件（2026-10-05）：以前是 mousedown/mousemove/mouseup，
 * 触屏上拖拽平移基本不可用、缩放更是只有滚轮 —— 手机上「平面」视图等于只能看。
 * 现在：单指/单键拖动平移、滚轮或双指捏合缩放、点按选中实体。
 */
let drag=null, downPos=null;
const pts2 = new Map();     // pointerId -> {x,y}
let pinch2 = null;          // 双指手势起始快照
let multi2 = false;         // 这一段出现过双指 → 抬手时不要当成「点选」

cv.addEventListener('pointerdown', e=>{
  cv.setPointerCapture(e.pointerId);
  pts2.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if(pts2.size === 1) multi2 = false;

  if(pts2.size === 2){
    const [p,q] = [...pts2.values()];
    multi2 = true; drag = null;
    pinch2 = { d: Math.hypot(p.x-q.x, p.y-q.y) || 1,
               mid: {x:(p.x+q.x)/2, y:(p.y+q.y)/2},
               s: view.s, ox: view.ox, oy: view.oy };
    return;
  }
  if(pts2.size > 2) return;

  downPos=[e.clientX,e.clientY];
  drag={x:e.clientX,y:e.clientY,ox:view.ox,oy:view.oy};
  cv.style.cursor='grabbing';
});
function endPtr2(e){
  pts2.delete(e.pointerId);
  if(pts2.size < 2) pinch2 = null;
  if(pts2.size === 0){ drag = null; cv.style.cursor='crosshair'; }
}
cv.addEventListener('pointerup', endPtr2);
cv.addEventListener('pointercancel', endPtr2);
cv.addEventListener('click', e=>{
  if(multi2) return;
  if(downPos && (Math.abs(e.clientX-downPos[0])>4 || Math.abs(e.clientY-downPos[1])>4)) return;
  if(!cur) return;
  const r = cv.getBoundingClientRect();
  const o = pick(e.clientX-r.left, e.clientY-r.top);
  if(o){ selectEnt(o, false); }
  else { $('edetail').style.display='none'; if(S.sel){ S.sel=null; draw(); } }
});
cv.addEventListener('pointermove', e=>{
  if(pts2.has(e.pointerId)) pts2.set(e.pointerId, {x:e.clientX, y:e.clientY});

  /* 双指：绕两指中点缩放，同时跟随中点整体平移 */
  if(pinch2 && pts2.size >= 2){
    const [p,q] = [...pts2.values()];
    const d = Math.hypot(p.x-q.x, p.y-q.y) || 1;
    const mid = {x:(p.x+q.x)/2, y:(p.y+q.y)/2};
    const r = cv.getBoundingClientRect();
    const s = Math.max(0.02, Math.min(40, pinch2.s * (d/pinch2.d)));
    /* 起手时中点下的那个世界坐标要钉在当前中点上 —— 缩放和平移一步算完 */
    const wx = (pinch2.mid.x - r.left - pinch2.ox)/pinch2.s;
    const wy = (pinch2.mid.y - r.top  - pinch2.oy)/pinch2.s;
    view.s = s;
    view.ox = (mid.x - r.left) - wx*s;
    view.oy = (mid.y - r.top ) - wy*s;
    draw(); hideTip(); return;
  }

  if(drag){
    view.ox = drag.ox + (e.clientX-drag.x);
    view.oy = drag.oy + (e.clientY-drag.y);
    draw(); hideTip(); return;
  }
  hover(e);
});
cv.addEventListener('pointerleave', hideTip);
cv.addEventListener('wheel', e=>{
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const mx = e.clientX-r.left, my = e.clientY-r.top;
  const wx = (mx-view.ox)/view.s, wy = (my-view.oy)/view.s;
  const f = e.deltaY<0 ? 1.15 : 1/1.15;
  view.s = Math.max(0.02, Math.min(40, view.s*f));
  view.ox = mx - wx*view.s; view.oy = my - wy*view.s;
  draw(); hideTip();
}, {passive:false});
cv.addEventListener('dblclick', fit);

function pick(mx,my){
  if(!cur) return null;
  const gmap={}; DATA.groups.forEach(g=>gmap[g.id]=g);
  const wx=(mx-view.ox)/view.s, wy=(my-view.oy)/view.s;
  const cx=Math.floor(wx/cur.cell), cy=Math.floor(wy/cur.cell);
  let best=null, bd=1e18;
  const lim = (10/view.s)**2;
  for(let i=-1;i<=1;i++) for(let j=-1;j<=1;j++){
    const arr = cur.grid.get((cx+i)+':'+(cy+j)); if(!arr) continue;
    for(const o of arr){
      const g=gmap[o.gid]; if(!g) continue;
      if(S.off.has(o.gid) || (S.solo && S.solo!==o.gid)) continue;
      if(S.coff.has(o.cn)) continue;
      if(!stageOk(o)) continue;
      const d=(o.px-wx)**2+(o.py-wy)**2;
      if(d<bd){bd=d;best=o;}
    }
  }
  return (best && bd<=Math.max(lim, 400/view.s)) ? best : null;
}
function hover(e){
  const r = cv.getBoundingClientRect();
  const mx=e.clientX-r.left, my=e.clientY-r.top;
  const o = pick(mx,my);
  if(!o){ hideTip(); return; }
  const g = DATA.groups.find(x=>x.id===o.gid);
  $('tip').innerHTML =
    `<b>${esc(g?g.label:o.gid)}</b><br>` +
    `类别 <i>${esc(o.cn)}</i>` +
    (o.nm?`<br>名称 <i>${esc(o.nm)}</i>`:'') +
    `<br>坐标 <i>${Math.round(o.x)}, ${Math.round(o.y)}, ${Math.round(o.z)}</i>` +
    `<br><span style="color:#d4547e">单击查看属性详情</span>`;
  $('tip').style.display='block';
  const tw = $('tip').offsetWidth, th = $('tip').offsetHeight;
  let lx = mx+14, ly = my+14;
  if(lx+tw > W-6) lx = mx-tw-14;
  if(ly+th > H-6) ly = Math.max(4, my-th-14);
  $('tip').style.left=lx+'px'; $('tip').style.top=ly+'px';
}
function hideTip(){ $('tip').style.display='none'; }

/* 图层点击 */
$('lbody').addEventListener('click', e=>{
  const si = e.target.closest('.si');
  if(si){
    const cn = si.dataset.cn;
    if(S.coff.has(cn)) S.coff.delete(cn); else S.coff.add(cn);
    renderLayers();
    if(S.mode === '3d'){ build3D(); render3D(); } else draw();
    return;
  }
  const xb = e.target.closest('.xbtn');
  if(xb){
    const g = xb.dataset.g;
    if(S.xopen.has(g)) S.xopen.delete(g); else S.xopen.add(g);
    renderLayers();
    return;
  }
  const li = e.target.closest('.li'); if(!li) return;
  const g = li.dataset.g;
  if(e.detail>1){ S.solo = (S.solo===g) ? null : g; }
  else if(g === 'env' && S.mode === '3d'){
    /* 三维里「环境点」默认不画，但它并不在 S.off 里 —— 如果照旧按 S.off 取反，
       第一次点击会变成「再关一次」，用户看着没反应（实测踩到）。
       所以这里按**实际显示状态**取反。 */
    const wantOn = !layerDrawn('env');
    if(wantOn){ S.off.delete('env'); env3d = true; }
    else { S.off.add('env'); env3d = false; if(S.solo === 'env') S.solo = null; }
  }
  else {
    if(S.off.has(g)){ S.off.delete(g); if(S.solo===g) S.solo=null; }
    else S.off.add(g);
  }
  renderLayers();
  if(S.mode === '3d'){
    build3D();
    render3D();
  } else {
    draw();
  }
});

/* 图层悬停说明（点云层 + 面板内功能行） */
const GDESC = {
  tele:  {desc:'传送触发区与传送目的地。人类玩家踩中后被瞬间送往下一区域；成串出现通常就是关卡切换点或捷径入口，是读路线的第一入口。',cls:'trigger_teleport · info_teleport_destination · point_teleport'},
  break: {desc:'可被打碎的墙板、玻璃、木板、栅栏与物理道具。打碎后常开辟新路或露出隐藏房，部分地图靠炸墙改道。',cls:'func_breakable(_surf) · prop_physics · func_physbox'},
  hurt:  {desc:'持续掉血区与火焰、爆炸点。用于判断哪里不能停留、该跳该绕；单击实体可在详情卡看具体伤害数值（如 999999 即摸即死）。',cls:'trigger_hurt · env_fire · env_explosion'},
  trig:  {desc:'隐形的关卡开关：玩家进入后触发关门、刷怪、推动、胜利判定等事件。本身不可见，是理解关卡流程的关键。',cls:'trigger_once / multiple / push · func_ladder'},
  mech:  {desc:'可交互机关：按钮、平移/旋转门、电梯、旋转体等。决定通行与解谜方式，常与触发区、逻辑节点联动。',cls:'func_button · func_door · func_movelinear · func_rotating'},
  path:  {desc:'轨道路径节点：移动墙、载具、逃跑车等沿这些点运动。末段的「逃跑线」常是最终逃脱路线，跟着节点走即可。',cls:'path_track · path_corner'},
  logic: {desc:'无实体体积的逻辑中枢，相当于地图的程序代码，串联触发与机关；只表示事件流的枢纽位置，场景里看不到。',cls:'logic_relay / case / timer · math_counter'},
  spawn: {desc:'玩家出生与复活位置。开局站位、重生点与防守压力分布的参考。',cls:'info_player_start · info_player_terrorist / counterterrorist'},
  item:  {desc:'武器与道具生成点。捡补给、拿装备的位置参考。',cls:'weapon_* · item_* · game_*'},
  prop:  {desc:'装饰与动态模型：雕像、招牌、场景摆设等视觉元素，一般不影响玩法；可打碎的物理道具已归入「可破坏物」。',cls:'prop_dynamic · prop_static · prop_ragdoll'},
  env:   {desc:'灯光、粒子、音效、天空盒等环境实体，不参与玩法；抽样后其分布用于生成「地形轮廓」密度底图。三维视图里默认不画（数量多、叠在地形上像噪点），需要时点这一行打开。',cls:'light_* · info_particle_system · ambient_generic'},
  misc:  {desc:'未归入上述类别的杂项实体，通常数量极少。',cls:'其余 classname'}
};
const ltipEl = $('ltip');
let ltipRow = null;
function ltipShow(row){
  if(ltipRow === row) return;
  ltipRow = row;
  let html = '';
  if(row.classList && row.classList.contains('li')){
    const gid = row.dataset.g;
    const g = DATA.groups.find(x=>x.id===gid);
    const d = GDESC[gid] || {desc:'',cls:''};
    const n = cur ? (cur.groups[gid]||0) : 0;
    html = `<span class="lt-head"><span class="lt-dot" style="background:${g?g.color:'#999'}"></span>`+
           `<b>${esc(g?g.label:gid)} · ${fmt(n)} 个点</b></span>`+
           (d.desc?`<br>${d.desc}`:'')+
           (d.cls?`<span class="lt-cls">典型类别：${esc(d.cls)}</span>`:'');
  } else {
    html = `<b>${esc(row.dataset.lt||'')}</b><br>${esc(row.dataset.desc||'')}`;
  }
  ltipEl.innerHTML = html;
  ltipEl.style.display = 'block';
  const r = row.getBoundingClientRect();
  const tw = ltipEl.offsetWidth, th = ltipEl.offsetHeight;
  let lx = r.left - tw - 10;
  if(lx < 8) lx = Math.min(r.right + 10, window.innerWidth - tw - 8);
  let ly = Math.min(Math.max(r.top, 8), window.innerHeight - th - 8);
  ltipEl.style.left = lx+'px'; ltipEl.style.top = ly+'px';
}
function ltipHide(){ ltipRow = null; ltipEl.style.display = 'none'; }
$('layers').addEventListener('mouseover', e=>{
  const li = e.target.closest('.li');
  const row = li || e.target.closest('[data-desc]');
  if(row) ltipShow(row);
});
$('layers').addEventListener('mouseleave', ltipHide);

/* 工具栏 */
$('mode').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  setMode(b.dataset.m);
});
$('proj').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  S.proj = b.dataset.p;
  [].forEach.call($('proj').children, x=>x.classList.toggle('on', x===b));
  if(S.key) loadMap(S.key);
});
$('hcol').addEventListener('change', e=>{ S.hcol=e.target.checked; draw(); if(S.mode==='3d'){ build3D(); render3D(); } });
$('glow').addEventListener('change', e=>{ S.glow=e.target.checked; draw(); });
$('full').addEventListener('change', e=>{ S.full=e.target.checked; if(S.key) loadMap(S.key); });
$('psize').addEventListener('input', e=>{ S.psize=parseFloat(e.target.value); draw(); });
$('vbox').addEventListener('change', e=>{ S.vbox=e.target.checked; build3D(); render3D(); });
{ const el=$('vbig'); if(el) el.addEventListener('change', e=>{ S.vbig=e.target.checked; build3D(); render3D(); }); }
$('terbox').addEventListener('change', e=>{ S.terrain=e.target.checked; refreshTerrain(); });
/* 地形那行的状态文字：加载失败时点一下重试（见 updateTerrRow 的说明） */
$('tstat')?.addEventListener('click', ()=>{ if(meshErrKey && S.terrain) refreshTerrain(); });

/* ===== 自由视角 / 行走模式：按钮与滑杆（设置自动记忆）=====
   用 on() 而不是直接 $().addEventListener：万一页面是旧的缓存版本、元素不存在，
   也不至于让后面所有脚本（包括加载地图）一起挂掉。 */
function on(id, ev, fn){ const el = $(id); if(el) el.addEventListener(ev, fn); }
const LS = {
  num(k, d, lo, hi){
    try{ const v = parseFloat(localStorage.getItem(k)); return (v >= lo && v <= hi) ? v : d; }
    catch(e){ return d; }
  },
  set(k, v){ try{ localStorage.setItem(k, v); }catch(e){} },
};

CAM.fspd  = LS.num('zmFlySpd', 1, 0.1, 5);
CAM.msens = LS.num('zmMouseSens', 1, 0.3, 3);
CAM.eyeH  = LS.num('zmEyeH', 1.7, 0.3, 40);
if($('fspd')){ $('fspd').value = Math.round(CAM.fspd*10); $('fspdv').textContent = CAM.fspd.toFixed(1)+'×'; }
if($('msens')){ $('msens').value = CAM.msens; $('msensv').textContent = CAM.msens.toFixed(1)+'×'; }
if($('eyeh')){ $('eyeh').value = Math.round(CAM.eyeH*10); $('eyehv').textContent = CAM.eyeH.toFixed(1)+'m'; }

on('fly', 'click', ()=>{
  if(CAM.walk){ CAM.walk = false; syncCamUi(); ensureFlyLoop(); }   // 行走 → 自由飞行：原地切
  else setFree(!CAM.free);
});
on('orbit', 'click', ()=>{
  if(CAM.walk) setWalk(false);
  else setFree(false);
});
on('walk', 'click', ()=> setWalk(!CAM.walk));
on('fspd', 'input', e=>{
  CAM.fspd = parseInt(e.target.value, 10)/10;
  $('fspdv').textContent = CAM.fspd.toFixed(1)+'×';
  LS.set('zmFlySpd', CAM.fspd);
});
on('msens', 'input', e=>{
  CAM.msens = parseFloat(e.target.value);
  $('msensv').textContent = CAM.msens.toFixed(1)+'×';
  LS.set('zmMouseSens', CAM.msens);
});
on('eyeh', 'input', e=>{
  const v = parseInt(e.target.value, 10)/10, old = CAM.eyeH;
  CAM.eyeH = v;
  $('eyehv').textContent = v.toFixed(1)+'m';
  LS.set('zmEyeH', v);
  if(CAM.walk && CAM.free){ CAM.ey += (v-old)*UNITS_PER_M; ensureFlyLoop(); }  // 脚底不动，只抬降视点
});
$('bopa').addEventListener('input', e=>{ S.bopa=e.target.value/100; build3D(); render3D(); });
$('stagesel').addEventListener('change', e=>{
  S.stage = parseInt(e.target.value, 10) || 0;
  if(S.sel && !stageOk(S.sel)){ S.sel = null; $('edetail').style.display='none'; }
  renderLayers(); renderStats();
  draw();
  if(S.mode === '3d') build3D();
  focusStage();
});
$('cutz').addEventListener('input', e=>{
  S.cutz = e.target.value/100;
  $('cutzv').textContent = e.target.value + '%';
  build3D(); render3D();
});
/* --- 显示设置四项（对齐云朵小铺那块面板）--- */
$('cutb').addEventListener('input', e=>{
  S.cutb = e.target.value/100;
  $('cutbv').textContent = e.target.value + '%';
  build3D(); render3D();
});
$('bsz').addEventListener('input', e=>{
  S.bsz = e.target.value/100;
  $('bszv').textContent = e.target.value + '%';
  build3D(); render3D();
});
$('psz').addEventListener('input', e=>{
  S.psz = e.target.value/100;
  $('pszv').textContent = e.target.value + '%';
  render3D();
});
$('topa').addEventListener('input', e=>{
  S.topa = e.target.value/100;
  $('topav').textContent = e.target.value + '%';
  render3D();
});
$('fit').addEventListener('click', ()=>{ if(S.mode==='3d'){ resetCam(); render3D(); } else fit(); });
$('png').addEventListener('click', ()=>{
  if(!cur) return;
  const src = (S.mode==='3d' && GLok) ? cv3 : cv;
  const a=document.createElement('a');
  a.download = '地图实体预览_'+(cur.m.cn||cur.m.m)+'_'+S.mode+'.png';
  a.href = src.toDataURL('image/png'); a.click();
});
$('q').addEventListener('input', buildSide);
document.querySelectorAll('.side-tools button').forEach(b=>{
  b.addEventListener('click', ()=>{
    S.sort = b.dataset.sort;
    document.querySelectorAll('.side-tools button').forEach(x=>x.classList.toggle('on', x===b));
    buildSide();
  });
});
/* 窄屏抽屉：侧栏默认收起，选图后自动关闭 */
function setSide(open){
  const aside = document.querySelector('aside');
  const scrim = $('side-scrim');
  if(!aside) return;
  aside.classList.toggle('open', open);
  if(scrim) scrim.classList.toggle('open', open);
  clearTimeout(setSide._t);
  setSide._t = setTimeout(()=>window.dispatchEvent(new Event('resize')), 260);
}
$('side-toggle')?.addEventListener('click', ()=>{
  const aside = document.querySelector('aside');
  setSide(!(aside && aside.classList.contains('open')));
});
$('side-scrim')?.addEventListener('click', ()=>setSide(false));

$('maps').addEventListener('click', e=>{
  const mi = e.target.closest('.mi'); if(!mi) return;
  const entry = entryOf(mi.dataset.k); if(!entry) return;
  setSide(false);
  $('lmsg').textContent = '正在加载 '+(entry.cn||entry.m)+' …';
  $('loading').style.display = 'flex';
  openMap(entry).then(()=>{ syncUrl(entry.s); $('loading').style.display='none'; })
    .catch(err=>{ $('lmsg').innerHTML = '载入失败：'+esc(err.message); });
});
const lmodeEl = $('lmode');
if(lmodeEl) lmodeEl.addEventListener('change', ()=>{ S.listMode = lmodeEl.value; buildSide(); });
$('lclose').addEventListener('click', ()=>{ $('layers').style.display='none'; $('ltoggle').style.display='block'; ltipHide(); });
$('btoggle').addEventListener('click', ()=>{ S.bmap=!S.bmap; $('btoggle').classList.toggle('off',!S.bmap); draw(); });
$('bop').addEventListener('input', e=>{ S.bop=e.target.value/100; draw(); });
$('ltoggle').addEventListener('click', ()=>{ $('layers').style.display='flex'; $('ltoggle').style.display='none'; });

/* ============================ 启动 ============================ */
(async function(){
  try{
    CATALOG = await fetchCatalog();
  }catch(err){
    document.querySelector('.spin').style.display='none';
    $('lmsg').innerHTML = '目录加载失败：'+esc(err.message);
    return;
  }
  const meta = CATALOG.meta || {};
  $('hbadges').innerHTML =
    `<span class="badge">${CATALOG.count} 张地图（全部模式）</span>` +
    (meta.entities_all ? `<span class="badge">${fmt(meta.entities_all)} 实体</span>` : '') +
    (meta.entities_kept ? `<span class="badge">${fmt(meta.entities_kept)} 可绘点</span>` : '') +
    `<span class="badge">${(CATALOG.groups||[]).length} 个图层</span>` +
    (meta.built ? `<span class="badge">数据 ${esc(meta.built)}</span>` : '');
  buildSide();
  resize();
  init3D();

  // 窄屏：图层面板默认收起（否则会盖住大半张地图），并收起侧栏抽屉
  const narrow = window.innerWidth <= 820;
  if (narrow) {
    $('layers').style.display = 'none';
    $('ltoggle').style.display = 'block';
  }

  // 打开哪张图：?map=<slug|内部名|中文名>，否则挑一张「玩法实体最丰富」的
  const Q = new URLSearchParams(location.search);
  const wantMap = Q.get('map');
  let entry = null;
  if(wantMap){
    const w = wantMap.toLowerCase();
    entry = CATALOG.maps.find(m => m.s.toLowerCase() === w)
         || CATALOG.maps.find(m => m.m.toLowerCase() === w)
         || CATALOG.maps.find(m => m.m.toLowerCase().includes(w))
         || CATALOG.maps.find(m => (m.cn||'').toLowerCase().includes(w));
  }
  if(!entry){
    let best = null;
    for(const m of CATALOG.maps){
      if(m.a !== '2001') continue;
      const c = m.c || {};
      const sc = (c.tele||0)*4 + (c.break||0)*3 + (c.hurt||0)*3 + Math.min(c.mech||0,300) + (c.path||0)*2 + (c.trig||0)
               + (m.bg?25000:0) + (m.rb?40000:0);
      if(!best || sc>best[1]) best=[m,sc];
    }
    entry = best ? best[0] : CATALOG.maps[0];
  }
  try{ await openMap(entry); }
  catch(err){ $('lmsg').textContent = '载入失败：' + err.message; document.title = 'ERR ' + err.stack; }
  $('loading').style.display='none';
  // 默认 3D（若不支持 WebGL 已自动回落 2D）
  setMode(Q.get('view') === '2d' ? '2d' : '3d');
  // ?stage=N 直接选中关卡层（0=全部 / -1=未标注 / n=第 n 关）
  const qsg = new URLSearchParams(location.search).get('stage');
  if(qsg !== null && cur){
    const v = parseInt(qsg, 10);
    const sel = $('stagesel');
    if([...sel.options].some(op => op.value === String(v))){
      sel.value = String(v);
      sel.dispatchEvent(new Event('change'));
    }
  }
  // ?demo=1 自测：自动搜索并选中一个实体，便于截图验证
  if(new URLSearchParams(location.search).has('demo')){
    setTimeout(()=>{
      $('esq').value = 'trigger_hurt';
      esRender();
      setTimeout(()=>{
        if($('esres').__hits && $('esres').__hits.length){
          selectEnt($('esres').__hits[0], true);
          $('esres').style.display = 'none';
        }
      }, 400);
    }, 600);
  }
  // ?yaw= / ?pitch= 便于截图验证不同机位
  const qs = new URLSearchParams(location.search);
  if(qs.has('yaw') || qs.has('pitch')){
    if(qs.has('yaw')) CAM.yaw = parseFloat(qs.get('yaw'));
    if(qs.has('pitch')) CAM.pitch = parseFloat(qs.get('pitch'));
    if(qs.has('zoom')) CAM.dist *= parseFloat(qs.get('zoom'));
    render3D();
  }
  // ?ltip=<gid> 截图验证：强制显示某图层的悬停说明
  (function(){
    const v = qs.get('ltip');
    if(!v) return;
    setTimeout(()=>{
      const li = document.querySelector('.li[data-g="'+v+'"]') ||
                 document.querySelector('[data-lt]');
      if(li) ltipShow(li);
    }, 900);
  })();
  // 默认使用自由视角；环绕视角通过工具栏按钮主动切换。
  // 放在 stage / yaw 参数处理之后，确保首次进入时仍聚焦到正确范围。
  if(S.mode === '3d' && !CAM.free) setFree(true);
})();
