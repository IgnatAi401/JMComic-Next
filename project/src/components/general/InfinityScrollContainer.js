export class InfinityScrollContainer {
    isLoading = false;
    pageIndex = 0;
    maxPageIndex = 10000;
    container;
    threshold;
    loadContent;
    coolingTime;
    prevLoadedTime = 0;

    constructor({
        container = null,
        threshold = 100,
        loadContent = () => {},
        coolingTime = 1000,
    }) {
        this.container = container;
        this.threshold = threshold;
        this.loadContent = loadContent;
        this.coolingTime = coolingTime;
        this.generation = 0;
        this.loadToken = 0;
        this.eventsBound = false;
    }

    init({ loadInitial = true } = {}) {
        this.addEvent();
        if (loadInitial) this.loadNextPage({ force: true, ignoreCooling: true });
    }

    addEvent() {
        if (this.eventsBound) return;
        this.eventsBound = true;
        this.scrollHandler = () => this.#onScroll();
        this.onlineHandler = () => this.loadNextPage({ ignoreCooling: true });
        window.addEventListener("scroll", this.scrollHandler, { passive: true });
        window.addEventListener("resize", this.scrollHandler, { passive: true });
        window.addEventListener("online", this.onlineHandler);
    }

    reset({ pageIndex = 0, maxPageIndex = 10000 } = {}) {
        this.generation += 1;
        this.pageIndex = pageIndex;
        this.maxPageIndex = maxPageIndex;
        this.isLoading = false;
        this.prevLoadedTime = 0;
    }

    resetAndLoad(options = {}) {
        this.reset(options);
        return this.loadNextPage({ force: true, ignoreCooling: true });
    }

    retry() {
        return this.loadNextPage({ force: true, ignoreCooling: true });
    }

    async loadNextPage({ force = false, ignoreCooling = false } = {}) {
        if (this.isLoading || this.pageIndex >= this.maxPageIndex) return false;
        if (!ignoreCooling && Date.now() - this.prevLoadedTime < this.coolingTime) return false;
        if (!force && this.#distanceFromBottom() >= this.threshold) return false;

        const page = this.pageIndex + 1;
        const generation = this.generation;
        const token = ++this.loadToken;
        this.isLoading = true;
        this.prevLoadedTime = Date.now();
        let loaded = false;

        try {
            await this.loadContent(page);
            if (generation !== this.generation || token !== this.loadToken) return false;
            this.pageIndex = page;
            loaded = true;
            return true;
        } catch {
            // Keep the page index unchanged. A later scroll, resize, online event or
            // explicit retry will request the same page again.
            return false;
        } finally {
            if (generation === this.generation && token === this.loadToken) {
                this.isLoading = false;
                this.prevLoadedTime = Date.now();
                if (loaded && this.pageIndex < this.maxPageIndex) {
                    window.setTimeout(() => this.#onScroll(), this.coolingTime);
                }
            }
        }
    }

    #onScroll() {
        this.loadNextPage();
    }

    #distanceFromBottom() {
        const documentElement = document.documentElement;
        const body = document.body;
        const scrollTop = window.scrollY ?? documentElement.scrollTop ?? body?.scrollTop ?? 0;
        const viewportHeight = window.innerHeight || documentElement.clientHeight || 0;
        const contentHeight = Math.max(
            documentElement.scrollHeight,
            documentElement.offsetHeight,
            body?.scrollHeight || 0,
            body?.offsetHeight || 0,
        );
        return Math.floor(contentHeight - scrollTop - viewportHeight);
    }
}
