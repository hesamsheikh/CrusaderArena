export async function request<T = unknown>(
  url: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(
    "/api/" + url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Crusader-Client": "dashboard",
          },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
