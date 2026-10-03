export const maskEmail = (e = '') => e.replace(/^(.).*(@.*)$/, '$1***$2');
export const maskPhone = (p = '') => (p.length > 4 ? `${'*'.repeat(p.length - 4)}${p.slice(-4)}` : '****');
