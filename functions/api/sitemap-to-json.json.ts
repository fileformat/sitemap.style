import { PagesFunction, EventContext
} from "@cloudflare/workers-types";
import { XMLParser } from "fast-xml-parser";

interface Env {}

function handleJsonp(ctx: EventContext<Env, any, any>, data: unknown) {

    const jsonStr = JSON.stringify(data); //, null, 2);
    let body:string;
    let headers = {}; 

    const me = new URL(ctx.request.url);
    let callback = me.searchParams.get("callback");
    if (callback) {
        headers["Content-Type"] = "application/javascript";
        body = `${callback}(${jsonStr})`;
    } else {
        headers["Content-Type"] = "application/json";
        body = jsonStr;
    }

    return new Response(body, {
        headers: {
            ...headers,
            "Cache-Control": "no-store, max-age=0",
            "X-Robots-Tag": "nofollow, noindex",
        },
    });

}

function errorMessage(err:unknown):string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

type TreeItem = {
    id: string;         // url if hasEntry, otherwise localpath
    label: string;
    localpath: string;
    filename: string;
    hasEntry: boolean;  // if false, it's a directory that does not have its own entry and thus should not be hyperlinked
    children?: TreeItem[];
}

type SitemapJsonResponse = {
    success: boolean;
    url: string;
    messages: string[];
    count: number;
    tree: TreeItem[];
    raw?: any;
};

export const onRequest: PagesFunction<Env> = async (ctx):Promise<Response> => {
    const me = new URL(ctx.request.url);
    let url_str = me.searchParams.get("url");
    if (!url_str) {
        return handleJsonp(ctx, {
            success: false,
            messages: [ "No ?url= parameter provided." ],
        });
    }

    const retVal: SitemapJsonResponse = {
        success: true,
        url: url_str,
        tree: [],
        messages: [],
        count: 0,
    };

    let url: URL;
    try {
        url = new URL(url_str);
    } catch (err: unknown) {
        retVal.success = false;
        retVal.messages.push(errorMessage(err));
        return handleJsonp(ctx, retVal);
    }

    const start = Date.now();

    let xml_resp: globalThis.Response;

    try {
        xml_resp = await fetch(url,
        {
            headers: {
                "User-Agent": `Sitemap.style/1.0 (your sitemap is being processed at https://www.sitemap.style/ )`,
                Referer: ctx.request.url,
            },
        });

        if (!xml_resp.ok) {
            retVal.success = false;
            retVal.messages.push("Failed to fetch sitemap: " + xml_resp.statusText);
            return handleJsonp(ctx, retVal);
        }
    } catch (err: unknown) {
        retVal.success = false;
        retVal.messages.push(errorMessage(err));
        return handleJsonp(ctx, retVal);
    }
    retVal.messages.push("Fetched sitemap in " + (Date.now() - start) + "ms.");
    retVal.messages.push(`Content length: ${xml_resp.headers.get("Content-Length")}`);
    retVal.messages.push(`Content type: ${xml_resp.headers.get("Content-Type")}`);

    const xml_str = await xml_resp.text();
    retVal.messages.push(`JS string length: ${xml_str.length}`);

    const parser = new XMLParser();
    const xml_data = parser.parse(xml_str);

    //retVal.raw = xml_data;

    loadTree(retVal, xml_data);

    return handleJsonp(ctx, retVal);
}

function loadTree(retVal: SitemapJsonResponse, data: any) {

    const root = retVal.tree;
    let count = 0;
    for (const entry of data.urlset.url) {
       const url = new URL(entry.loc);
       let paths = url.pathname.split("/");
       if (paths.length < 2) {
           // no path?!?
           retVal.messages.push(`no path from url "${entry.loc}"`);
           continue;
       }
       if (paths[0] != "") {
           retVal.messages.push(`path does not start with / for "${entry.loc}"`);
           continue;
       }
       paths.shift(); // remove first blank entry

       if (defaultPaths.has(paths[paths.length - 1])) {
           paths.pop();
       }

       let name: string;
       if (url.pathname == "/") {
           paths.pop();
           name = "Home Page";
       } else if (url.pathname.endsWith("/")) {
           paths.pop(); // remove the blank entry
           //LATER: fancier default index removal
           name = paths.pop() || "Should not occur";
       } else {
           name = paths.pop() || "Should not occur";
           //LATER: fancier extension cleanup
           if (name.endsWith(".html")) {
               name = name.slice(0, -5);
           } else if (name.endsWith(".htm")) {
               name = name.slice(0, -4);
           }
       }

       const parentPath = paths.length > 0 ? "/" + paths.join("/") + "/" : "/";

       let parent: TreeItem[];
       parent = findOrCreateParents(root, paths);

       let item = parent.find((item) => item.localpath == url.pathname);
       if (item) {
            // this happens when a directory entry is found after a file entry from that directory
           item.id = entry.loc;
           item.hasEntry = true;
           item.label = `${name}`; // (dup id=${entry.pathname})`;
           continue;
       } else {
           const item: TreeItem = {
               id: entry.loc,
               localpath: url.pathname,
               filename: paths[paths.length - 1] || name,
               label: `${name}`, // (direct id=${url.pathname} paths=${JSON.stringify(paths)})`,
               children: [],
               hasEntry: true,
           };
           parent.push(item);
       }
       count++;
       if (count > 500) {
           break;
       }
   }
   retVal.count += count;
   return root;
}

const defaultPaths: Set<String> = new Set([
    "default.htm",
    "default.html",
    "index.htm",
    "index.html",
]);

function findFile(parent: TreeItem[], filename: string): TreeItem | null {
    for (const item of parent) {
        if (item.filename == filename) {
            return item;
        }
    }
    return null;
}

function findOrCreateParent(
    parent: TreeItem[],
    fullpath: string,
    directory: string
): TreeItem[] {
    let item = findFile(parent, directory);
    if (item) {
        return item.children as TreeItem[];
    }
    item = {
        id: `local:${fullpath}`,
        localpath: fullpath,
        filename: directory || "indirect should not occur",
        label: `${directory}`, // (indirect id=${fullpath})`,
        children: [],
        hasEntry: false,
    };
    parent.push(item);
    return item.children as TreeItem[];
}

function findOrCreateParents(parent: TreeItem[], paths: string[]): TreeItem[] {
    if (paths.length == 0) {
        return parent;
    }

    for (let index = 0; index < paths.length; index++) {
        const fullpath = `/${paths.slice(0, index + 1).join("/")}/`;
        const directory = paths[index];
        parent = findOrCreateParent(parent, fullpath, directory);
    }
    return parent;
}
