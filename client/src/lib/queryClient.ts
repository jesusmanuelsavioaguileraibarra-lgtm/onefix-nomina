import { QueryClient, QueryFunction } from "@tanstack/react-query";

export const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
let authToken = "";
export function setAuthToken(token:string) { authToken=token; }
function headers(data?:unknown):Record<string,string> {
  return {
    ...(data !== undefined ? {"Content-Type":"application/json"} : {}),
    ...(authToken ? {Authorization:`Bearer ${authToken}`} : {}),
    "X-Onefix-Request":"1",
  };
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: headers(data),
    credentials:"same-origin",
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await apiRequest("GET",`${queryKey.join("/")}`).catch((e) => {
      if (unauthorizedBehavior === "returnNull" && String(e).startsWith("Error: 401:")) return null;
      throw e;
    });

    return res ? await res.json() : null;
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
