/**
 * Lets Node run the trierarch from its TypeScript source, as a test starts a
 * hold the way the trierarch does: a relative `.js` import that has no file
 * resolves to the `.ts` beside it. Node strips the types itself.
 */
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
