import {
  findPathCells,
  flowField as flowFieldJs,
  integrate as integrateJs,
  separate as separateJs,
  traceFlow as traceFlowJs,
  updateFog as updateFogJs,
} from '../sim/kernels.ts';

/** Numeric navigator used by the match simulation. Wasm when it loads, JS otherwise. */
export interface NativeNavigator {
  readonly backend: 'wasm' | 'js';
  uploadBlocked(blocked: Uint8Array, w: number, h: number): void;
  findPath(sx: number, sz: number, gx: number, gz: number): Int32Array;
  flowField(gx: number, gz: number): Uint8Array;
  traceFlow(dirs: Uint8Array, sx: number, sz: number): Int32Array;
  updateFog(fog: Uint8Array, w: number, h: number, cx: Int32Array, cz: Int32Array, radii: Float32Array): Uint8Array;
  separate(xs: Float32Array, zs: Float32Array, radii: Float32Array): Float32Array;
  integrate(
    xs: Float32Array,
    zs: Float32Array,
    txs: Float32Array,
    tzs: Float32Array,
    sepX: Float32Array,
    sepZ: Float32Array,
    speeds: Float32Array,
    dt: number,
  ): Float32Array;
}

interface WasmExports {
  uploadBlocked(blocked: Uint8Array, w: number, h: number): void;
  findPath(sx: number, sz: number, gx: number, gz: number): Int32Array;
  flowField(gx: number, gz: number): Uint8Array;
  traceFlow(dirs: Uint8Array, sx: number, sz: number): Int32Array;
  updateFog(fog: Uint8Array, w: number, h: number, cx: Int32Array, cz: Int32Array, radii: Float32Array): Uint8Array;
  separate(xs: Float32Array, zs: Float32Array, radii: Float32Array): Float32Array;
  integrate(
    xs: Float32Array,
    zs: Float32Array,
    txs: Float32Array,
    tzs: Float32Array,
    sepX: Float32Array,
    sepZ: Float32Array,
    speeds: Float32Array,
    dt: number,
  ): Float32Array;
}

class JsNavigator implements NativeNavigator {
  readonly backend = 'js' as const;
  private blocked: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private w = 0;
  private h = 0;

  uploadBlocked(blocked: Uint8Array, w: number, h: number): void {
    this.blocked = blocked;
    this.w = w;
    this.h = h;
  }

  findPath(sx: number, sz: number, gx: number, gz: number): Int32Array {
    return findPathCells(this.blocked, this.w, this.h, sx, sz, gx, gz);
  }

  flowField(gx: number, gz: number): Uint8Array {
    return flowFieldJs(this.blocked, this.w, this.h, gx, gz);
  }

  traceFlow(dirs: Uint8Array, sx: number, sz: number): Int32Array {
    return traceFlowJs(dirs, this.w, this.h, sx, sz);
  }

  updateFog(fog: Uint8Array, w: number, h: number, cx: Int32Array, cz: Int32Array, radii: Float32Array): Uint8Array {
    return updateFogJs(fog, w, h, cx, cz, radii);
  }

  separate(xs: Float32Array, zs: Float32Array, radii: Float32Array): Float32Array {
    return separateJs(xs, zs, radii);
  }

  integrate(
    xs: Float32Array,
    zs: Float32Array,
    txs: Float32Array,
    tzs: Float32Array,
    sepX: Float32Array,
    sepZ: Float32Array,
    speeds: Float32Array,
    dt: number,
  ): Float32Array {
    return integrateJs(this.blocked, this.w, this.h, xs, zs, txs, tzs, sepX, sepZ, speeds, dt);
  }
}

class WasmNavigator implements NativeNavigator {
  readonly backend = 'wasm' as const;
  private readonly wasm: WasmExports;
  constructor(wasm: WasmExports) {
    this.wasm = wasm;
  }

  uploadBlocked(blocked: Uint8Array, w: number, h: number): void {
    this.wasm.uploadBlocked(blocked, w, h);
  }

  findPath(sx: number, sz: number, gx: number, gz: number): Int32Array {
    return this.wasm.findPath(sx, sz, gx, gz);
  }

  flowField(gx: number, gz: number): Uint8Array {
    return this.wasm.flowField(gx, gz);
  }

  traceFlow(dirs: Uint8Array, sx: number, sz: number): Int32Array {
    return this.wasm.traceFlow(dirs, sx, sz);
  }

  updateFog(fog: Uint8Array, w: number, h: number, cx: Int32Array, cz: Int32Array, radii: Float32Array): Uint8Array {
    return this.wasm.updateFog(fog, w, h, cx, cz, radii);
  }

  separate(xs: Float32Array, zs: Float32Array, radii: Float32Array): Float32Array {
    return this.wasm.separate(xs, zs, radii);
  }

  integrate(
    xs: Float32Array,
    zs: Float32Array,
    txs: Float32Array,
    tzs: Float32Array,
    sepX: Float32Array,
    sepZ: Float32Array,
    speeds: Float32Array,
    dt: number,
  ): Float32Array {
    return this.wasm.integrate(xs, zs, txs, tzs, sepX, sepZ, speeds, dt);
  }
}

let impl: NativeNavigator = new JsNavigator();
let generation = 0;

export function getNative(): NativeNavigator {
  return impl;
}

export function nativeGeneration(): number {
  return generation;
}

export function useJsBackend(): void {
  impl = new JsNavigator();
  generation++;
}

/** Compile and bind the AssemblyScript module. On any failure the JS navigator stays active. */
export async function loadNative(): Promise<'wasm' | 'js'> {
  try {
    const url = new URL('./pkg/nav.wasm', import.meta.url);
    const bytes = await readWasm(url);
    const module = await WebAssembly.compile(bytes);
    const bindings = (await import('./pkg/nav.js')) as {
      instantiate(module: WebAssembly.Module, imports: { env: unknown }): Promise<WasmExports>;
    };
    const wasm = await bindings.instantiate(module, { env: {} });
    impl = new WasmNavigator(wasm);
    generation++;
    return 'wasm';
  } catch (err) {
    console.warn('Glassreach Wasm navigator failed to load; using the JavaScript fallback.', err);
    impl = new JsNavigator();
    generation++;
    return 'js';
  }
}

async function readWasm(url: URL): Promise<ArrayBuffer> {
  if (typeof window === 'undefined') {
    const fs = await import(/* @vite-ignore */ 'node:fs/promises');
    const buf = await fs.readFile(url);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wasm fetch failed (${res.status})`);
  return res.arrayBuffer();
}
