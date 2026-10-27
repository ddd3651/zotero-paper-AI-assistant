var PaperChatText = {
  configure(data) { this.data = data; },
  t(key, values = {}) {
    const template = key.split('.').reduce((value, part) => value?.[part], this.data);
    if (typeof template !== 'string') throw new Error('Missing interface text: ' + key);
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
  },
};
