/**
 * Engine 进程的最小 Web API polyfill。
 *
 * Electron utilityProcess 的内置 Node（当前 20.x）让 pdf-parse 选择
 * pdfjs-dist 的 legacy 构建，该构建在**模块顶层**就 new DOMMatrix()。
 * 我们只做文字提取，不渲染 canvas——一个保运算语义的轻量矩阵实现足够。
 * 必须是 engine 入口的第一个 import（ESM 求值顺序保证先于 converter 链）。
 */

class DOMMatrixPolyfill {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: number[] | string) {
    if (Array.isArray(init) && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    }
  }

  multiply(o: DOMMatrixPolyfill): DOMMatrixPolyfill {
    const m = new DOMMatrixPolyfill();
    m.a = this.a * o.a + this.c * o.b;
    m.b = this.b * o.a + this.d * o.b;
    m.c = this.a * o.c + this.c * o.d;
    m.d = this.b * o.c + this.d * o.d;
    m.e = this.a * o.e + this.c * o.f + this.e;
    m.f = this.b * o.e + this.d * o.f + this.f;
    return m;
  }

  translate(tx = 0, ty = 0): DOMMatrixPolyfill {
    const o = new DOMMatrixPolyfill([1, 0, 0, 1, tx, ty]);
    return this.multiply(o);
  }

  scale(sx = 1, sy = sx): DOMMatrixPolyfill {
    const o = new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]);
    return this.multiply(o);
  }

  transformPoint(p: { x: number; y: number }): { x: number; y: number } {
    return { x: this.a * p.x + this.c * p.y + this.e, y: this.b * p.x + this.d * p.y + this.f };
  }
}

// pdfjs 的 isNodeJS 检测把 `process.versions.electron` 存在视为"Electron 渲染环境"
// （要求真 worker：No "GlobalWorkerOptions.workerSrc" specified）。Engine 是纯 Node
// 宿主，摘掉该标记让 pdfjs 走 Node 路径（fake worker，无需 workerSrc）。
try {
  delete (process.versions as unknown as Record<string, unknown>).electron;
} catch {
  /* versions 不可写时退回 polyfill 兜底 */
}

const g = globalThis as Record<string, unknown>;
g.DOMMatrix ??= DOMMatrixPolyfill;

// pdfjs 运行期还会摸 navigator（Node 21+ 才有全局 navigator；Electron 内置 Node 20 没有）
g.navigator ??= { userAgent: 'node', platform: process.platform, language: 'en' };

// pdfjs 现代特性兜底（Node 20 没有 Promise.withResolvers）
const P = Promise as unknown as { withResolvers?: () => unknown };
if (typeof P.withResolvers !== 'function') {
  P.withResolvers = function withResolvers<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
