export function Badge({ text, status = "default" }: { text: string, status?: "success" | "warning" | "error" | "default" }) {
  const colors = {
    success: "bg-green-500",
    warning: "bg-yellow-500",
    error: "bg-red-500",
    default: "bg-gray-300"
  };

  return (
    <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-50 text-xs font-medium text-gray-700 border border-gray-100">
      <span className={`w-2 h-2 rounded-full ${colors[status]}`}></span>
      {text}
    </span>
  );
}