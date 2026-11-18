# Designer demo: Lumen pricing

A tiny product site with a design system, made for trying Designer.

- `src/tokens.css` holds the design tokens (colours, radii, spacing, type). Change one in Designer's **Code › Tokens** tab and every component follows.
- `src/components/` holds `Button`, `Badge` and `PriceCard`, each with a Storybook story, so they can sit on the canvas rendered from code.
- `src/App.tsx` is the pricing page that uses them.

Try asking Claude:

- "Run this project and put the pricing page on the canvas."
- "Make the cards denser and the primary button pill-shaped."
- "Add a Ghost variant to Button, with a story."

Run it yourself with `npm install`, then `npm run dev` (the page) or `npm run storybook` (the components).
