import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RotateCw } from 'lucide-react';

/**
 * 全局错误边界：任何视图抛出的渲染错误都被接住，显示一个友好的全屏兜底页
 * （而不是整窗白屏不可恢复）。数据都在本地磁盘，重载即恢复。
 * Error Boundary 必须是 class 组件；文案交给函数式 Fallback 以复用 i18n。
 */
function ErrorFallback({ error, onReload }: { error: Error; onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 40,
        textAlign: 'center',
        background: 'var(--surface-window)',
        color: 'var(--text-primary)',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'var(--status-dead-soft)',
          color: 'var(--status-dead)',
        }}
      >
        <AlertTriangle size={26} />
      </span>
      <h1 style={{ margin: 0, fontSize: 'var(--text-title-3)', fontWeight: 700 }}>
        {t('error.title')}
      </h1>
      <p
        style={{
          margin: 0,
          maxWidth: 420,
          fontSize: 'var(--text-subhead)',
          lineHeight: 'var(--leading-normal)',
          color: 'var(--text-secondary)',
        }}
      >
        {t('error.body')}
      </p>
      <button
        type="button"
        onClick={onReload}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '9px 18px',
          border: 'none',
          cursor: 'pointer',
          borderRadius: 'var(--radius-control)',
          background: 'var(--accent)',
          color: 'var(--text-on-accent)',
          fontSize: 'var(--text-callout)',
          fontWeight: 600,
        }}
      >
        <RotateCw size={15} />
        {t('error.reload')}
      </button>
      {error.message && (
        <details style={{ maxWidth: 480, marginTop: 4 }}>
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 'var(--text-caption)',
              color: 'var(--text-tertiary)',
            }}
          >
            {t('error.detail')}
          </summary>
          <pre
            style={{
              margin: '8px 0 0',
              padding: '10px 12px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--surface-sunken)',
              font: 'var(--font-code)',
              fontSize: 'var(--text-caption)',
              color: 'var(--text-secondary)',
              whiteSpace: 'pre-wrap',
              textAlign: 'left',
              overflow: 'auto',
              maxHeight: 160,
            }}
          >
            {error.message}
          </pre>
        </details>
      )}
    </div>
  );
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 控制台留痕，方便用户/我们排查（toast 之外的一道审计）
    console.error('[pith] render error caught by ErrorBoundary:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback error={this.state.error} onReload={() => window.location.reload()} />
      );
    }
    return this.props.children;
  }
}
