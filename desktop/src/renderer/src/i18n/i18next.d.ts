/** key 类型注入：t() 的 key 错拼 / 引用不存在的 key 都是编译错。 */
import type { zh } from './zh';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof zh };
    returnNull: false;
  }
}
