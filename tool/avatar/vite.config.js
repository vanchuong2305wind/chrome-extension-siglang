import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    build: {
        outDir: '../../android/app/src/main/assets/avatar',
        emptyOutDir: false,
        target: 'chrome100',
        rolldownOptions: { output: { entryFileNames: 'assets/avatar.js' } },
    },
});

