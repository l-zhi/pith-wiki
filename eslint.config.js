// ESLint 9 flat config. 故意保守：
//   - 第一版只想抓真正的 bug 类问题（unused vars / dangling promises），
//     不抓风格（风格交给 prettier）。
//   - 一堆已有代码做不到 @typescript-eslint/recommended 全过；用 'warn' 而不是
//     'error' 让 CI 不挂红。等 codebase 清理过一遍再升级 'error'。
//   - 测试目录放宽一些（允许 any、any-assertion、long files）。
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';

export default [
  {
    ignores: ['dist/', 'node_modules/', 'wiki-data/', 'output/', '.cache/', 'coverage/'],
  },
  ...tseslint.configs.recommended,
  {
    plugins: { prettier: prettierPlugin },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // 真正想抓的 bug
      'no-unused-vars': 'off', // 让给 @typescript-eslint 版本，避免重复报
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'off', // 需要 type-aware lint，第二版再加
      // 保守降级：现有代码有大量 any / non-null assertion，第一版不挂红
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // prettier 整合：格式问题作为 warn 报出来，让 CI 提示但不阻塞
      'prettier/prettier': 'warn',
    },
  },
  {
    // 测试：允许更松散的写法
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  prettier,
];
