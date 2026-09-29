const stamp = () => new Date().toISOString();
const write = (level, msg) => console.log(`${stamp()} [${level}] ${msg}`);

export const log = {
  info: (m) => write('info', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m instanceof Error ? `${m.message}\n${m.stack}` : m),
  debug: (m) => process.env.NODE_ENV !== 'production' && write('debug', m),
};

export default log;
