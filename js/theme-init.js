// FOUC(Flash of Unstyled Content) 방지 — <head>에서 인라인으로 실행되어야 함
(function() {
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
})();
