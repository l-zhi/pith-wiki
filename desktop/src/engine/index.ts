/**
 * Engine 入口（utilityProcess）。
 *
 * 为什么拆成 polyfills → dynamic import(bootstrap)：
 * bootstrap 的依赖链里 pdf-parse → pdfjs legacy 在**模块顶层**就 new DOMMatrix()，
 * 而 ESM 静态 import 全部提升、先于本模块任何语句求值——polyfill 写在同一模块里
 * 永远来不及。动态 import 是唯一可靠的求值分界：polyfills 装完，bootstrap 的
 * 外部依赖才开始加载。
 */
import './polyfills.js';

void import('./bootstrap.js');
