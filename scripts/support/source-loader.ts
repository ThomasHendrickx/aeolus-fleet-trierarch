/** Resolves the contract helpers' relative .js imports to their TypeScript source in Node. */
import { registerHooks } from 'node:module';

registerHooks({
  // eslint-disable-next-line @typescript-eslint/max-params -- Node's resolve hook takes these three, in this order.
  resolve: (specifier, context, nextResolve) => {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context);
      }
      throw error;
    }
  },
});
