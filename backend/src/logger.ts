type Severity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

// Cloud Loggingが解釈する構造化ログ。トークン・クエリ文字列は呼び出し側で渡さない。
export function log(severity: Severity, message: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_SILENT === '1') return;
  const entry = JSON.stringify({ severity, message, ...fields });
  (severity === 'ERROR' || severity === 'WARNING' ? process.stderr : process.stdout).write(`${entry}\n`);
}
