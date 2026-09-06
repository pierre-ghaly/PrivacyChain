export function Card({ children, className = "" }: { children: React.ReactNode, className?: string }) {
  return (
    <div className={`bg-white border border-gray-200/50 rounded-3xl shadow-[0_2px_10px_rgba(0,0,0,0.02)] p-8 ${className}`}>
      {children}
    </div>
  );
}