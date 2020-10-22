const path = require("path");
const fs = require("fs-extra");
const slash = require("slash");
const crypto = require("crypto");
const mime = require("mime-types");
const { mapValues, trim, trimEnd } = require("lodash");

const isDev = process.env.NODE_ENV === "development";

class DocumentationSource {
  static defaultOptions() {
    return {
      baseDir: undefined,
      path: undefined,
      route: undefined,
      pathPrefix: undefined,
      sidebarOrder: {},
      index: ["index"],
      typeName: "FileNode",
      refs: {},
    };
  }

  constructor(api, options) {
    this.api = api;
    this.options = options;
    this.context = options.baseDir ? api.resolve(options.baseDir) : api.context;
    this.refsCache = {};

    api.loadSource(async (actions) => {
      this.createCollections(actions);
      await this.createNodes(actions);
      this.createSidebar(actions);

      if (isDev) this.watchFiles(actions);
    });
  }

  sortSection(nodes) {
    nodes.sort((a, b) => (a.weight > b.weight ? 1 : -1));

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];

      if (i + 1 < nodes.length) {
        node.next = nodes[i + 1].path;
      }

      if (i > 0) {
        node.prev = nodes[i - 1].path;
      }
    }
  }

  createSidebar(actions) {
    let collection = actions.addCollection({ typeName: "Sidebar" });

    let sidebar = {};

    Object.keys(this.options.sidebarOrder).forEach((id) => {
      const order = this.options.sidebarOrder[id];
      order.forEach((title) => {
        const query = {
          section: { $eq: title },
          version: { $eq: id },
        };

        let nodes = this.collection.findNodes(query);

        this.sortSection(nodes);

        nodes.forEach((node) => {
          this.createSidebarSection(sidebar, node);
        });
      });
    });

    for (const key in sidebar) {
      if (sidebar.hasOwnProperty(key)) {
        const element = { id: key, sections: sidebar[key].sections };
        collection.addNode(element);
      }
    }
  }

  createSidebarSection(sidebar, node) {
    const version = node.version;
    const title = node.section;

    if (typeof sidebar[version] === "undefined") {
      sidebar[version] = {
        sections: [],
      };
    }

    let section = {
      title: title,
      items: [],
    };

    if (sidebar[version].sections.some((e) => e.title === title)) {
      let obj = sidebar[version].sections.find((e) => e.title === title);
      obj.items.push(node.path);
    } else {
      section.items.push(node.path);
      sidebar[version].sections.push(section);
    }
  }

  createCollections(actions) {
    const addCollection = actions.addCollection || actions.addContentType;

    this.refs = this.normalizeRefs(this.options.refs);

    this.collection = addCollection({
      typeName: this.options.typeName,
      route: this.options.route,
    });

    mapValues(this.refs, (ref, key) => {
      this.collection.addReference(key, ref.typeName);

      if (ref.create) {
        addCollection({
          typeName: ref.typeName,
          route: ref.route,
        });
      }
    });
  }

  async createNodes(actions) {
    const glob = require("globby");

    const files = await glob(this.options.path, { cwd: this.context });

    await Promise.all(
      files.map(async (file) => {
        const options = await this.createNodeOptions(file, actions);
        const node = this.collection.addNode(options);

        this.createNodeRefs(node, actions);
      })
    );
  }

  createNodeRefs(node, actions) {
    for (const fieldName in this.refs) {
      const ref = this.refs[fieldName];

      if (node && node[fieldName] && ref.create) {
        const value = node[fieldName];
        const typeName = ref.typeName;

        if (Array.isArray(value)) {
          value.forEach((value) =>
            this.addRefNode(typeName, fieldName, value, actions)
          );
        } else {
          this.addRefNode(typeName, fieldName, value, actions);
        }
      }
    }
  }

  watchFiles(actions) {
    const chokidar = require("chokidar");

    const watcher = chokidar.watch(this.options.path, {
      cwd: this.context,
      ignoreInitial: true,
    });

    watcher.on("add", async (file) => {
      const options = await this.createNodeOptions(slash(file), actions);
      const node = this.collection.addNode(options);

      this.createNodeRefs(node, actions);
    });

    watcher.on("unlink", (file) => {
      const absPath = path.join(this.context, slash(file));

      this.collection.removeNode({
        "internal.origin": absPath,
      });
    });

    watcher.on("change", async (file) => {
      const options = await this.createNodeOptions(slash(file), actions);
      const node = this.collection.updateNode(options);

      this.createNodeRefs(node, actions);
    });
  }

  // helpers

  createDocInfo(file) {
    const dir = path.dirname(file);
    const parts = dir.split("/");

    switch (parts.length) {
      case 1:
        return {
          version: parts[0],
        };
      case 2:
        return {
          version: parts[0],
          section: parts[1],
        };
      default:
        break;
    }
  }

  async createNodeOptions(file, actions) {
    const relPath = path.relative(this.context, file);
    const origin = path.join(this.context, file);
    const content = await fs.readFile(origin, "utf8");
    const { dir, name, ext = "" } = path.parse(file);
    const mimeType =
      mime.lookup(file) || `application/x-${ext.replace(".", "")}`;
    const docInfo = this.createDocInfo(file);

    return {
      id: this.createUid(relPath),
      path: this.createPath({ dir, name }, actions),
      fileInfo: {
        extension: ext,
        directory: dir,
        path: file,
        name,
      },
      version: docInfo.version,
      section: docInfo.section,
      internal: {
        mimeType,
        content,
        origin,
      },
    };
  }

  addRefNode(typeName, fieldName, value, actions) {
    const getCollection = actions.getCollection || actions.getContentType;
    const cacheKey = `${typeName}-${fieldName}-${value}`;

    if (!this.refsCache[cacheKey] && value) {
      this.refsCache[cacheKey] = true;

      getCollection(typeName).addNode({ id: value, title: value });
    }
  }

  createPath({ dir, name }, actions) {
    const { permalinks = {} } = this.api.config;
    const pathPrefix = trim(this.options.pathPrefix, "/");
    const pathSuffix = permalinks.trailingSlash ? "/" : "";

    const segments = slash(dir)
      .split("/")
      .map((segment) => {
        return actions.slugify(segment);
      });

    if (!this.options.index.includes(name)) {
      segments.push(actions.slugify(name));
    }

    if (pathPrefix) {
      segments.unshift(pathPrefix);
    }

    const res = trimEnd("/" + segments.filter(Boolean).join("/"), "/");

    return res + pathSuffix || "/";
  }

  normalizeRefs(refs) {
    return mapValues(refs, (ref) => {
      if (typeof ref === "string") {
        ref = { typeName: ref, create: false };
      }

      if (!ref.typeName) {
        ref.typeName = this.options.typeName;
      }

      if (ref.create) {
        ref.create = true;
      } else {
        ref.create = false;
      }

      return ref;
    });
  }

  createUid(orgId) {
    return crypto.createHash("md5").update(orgId).digest("hex");
  }
}

module.exports = DocumentationSource;
