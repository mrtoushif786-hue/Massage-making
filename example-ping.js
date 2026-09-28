// Apna plugin banane ka example. Is file ko copy karke naya .js banao, restart karo, menu > 10 me dikhega.
export default {
  name: 'ping',
  description: '"ping" bhejne par "pong" + counter reply deta hai',
  // Menu me kholne par ye chalta hai. ctx.store me apna data save hota hai (config.json me).
  async menu({ ask, store }) {
    console.log('Ab tak pings:', store.count || 0);
    const reset = await ask('Counter reset karna hai? (y/n): ');
    if (reset.toLowerCase() === 'y') store.count = 0;
  },
  // Har incoming message par chalta hai. String return karo to wahi reply jayega, null = aage Gemini/rules dekhe.
  async onMessage({ text, store }) {
    if (text.trim().toLowerCase() !== 'ping') return null;
    store.count = (store.count || 0) + 1;
    return `pong 🏓 (#${store.count})`;
  }
  // Optional: async onStart({ send, ai, cfg }) { ... }  -> bot start hote hi chale
};
