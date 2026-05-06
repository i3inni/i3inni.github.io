tailwind.config = {
    darkMode: 'class',
    theme: {
        extend: {
            fontFamily: {
                sans: ['Noto Sans KR', 'sans-serif'],
                poppins: ['Poppins', 'sans-serif'],
            },
            colors: {
                'primary': '#6366F1',
                'primary-hover': '#4F46E5',
                'light-bg': '#F9FAFB',
                'light-card': '#FFFFFF',
                'light-text': '#111827',
                'light-subtext': '#4B5563',
                'dark-bg': '#111827',
                'dark-card': '#1F2937',
                'dark-text': '#E5E7EB',
                'dark-subtext': '#9CA3AF',
            },
            backgroundImage: {
                'radial-dark': 'radial-gradient(circle, #1f2937 0%, #111827 70%)',
            }
        }
    }
}
