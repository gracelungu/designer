# Lumen demo

This is Designer's bundled demo project: a Vite + React pricing page with a small design system.

- Design tokens are CSS custom properties in `src/tokens.css`. Components use only these tokens, never raw colours or sizes.
- Each component in `src/components/` has a `*.stories.tsx` file next to it. When you add a component or a variant, add or update its story.
- Run the page with `npm run dev` (port 5180) and Storybook with `npm run storybook` (port 6106). Run `npm install` first if `node_modules` is missing.
