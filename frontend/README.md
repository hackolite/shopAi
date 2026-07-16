# Retail Digital Twin — Frontend

React + TypeScript + Vite frontend for the Retail Digital Twin MVP.

## Stack

- [React](https://react.dev/) — UI framework
- [Vite](https://vite.dev/) — build tool (via `@vitejs/plugin-react` which uses Babel for JSX transformation)
- [TypeScript](https://www.typescriptlang.org/) — type safety
- [Three.js](https://threejs.org/) + [React Three Fiber](https://docs.pmnd.rs/react-three-fiber) — 3D rendering
- [Drei](https://github.com/pmndrs/drei) — Three.js helpers
- [Tailwind CSS v4](https://tailwindcss.com/) — utility-first styling

## Development

```bash
npm install
npm run dev        # start dev server on http://localhost:5173
npm run build      # production build
npm run preview    # preview production build
```

> The backend must be running on `http://localhost:8000` — see the root README for setup instructions.
