export class SafeEvaluation {
    constructor() {
        this.evaluationDom = document.querySelector(".evaluation");
        this.likesDom = this.evaluationDom?.querySelector(".likes span");
        this.viewsDom = this.evaluationDom?.querySelector(".views span");
        this.photosDom = this.evaluationDom?.querySelector(".photos span");
        this.jmidDom = this.evaluationDom?.querySelector(".jm-id span");
    }

    init(album = {}) {
        if (this.likesDom) this.likesDom.textContent = this.formatNumber(album.likes);
        if (this.viewsDom) this.viewsDom.textContent = this.formatNumber(album.total_views);
        if (this.photosDom) this.photosDom.textContent = album.total_photos == null ? "—" : String(album.total_photos);
        if (this.jmidDom) this.jmidDom.textContent = album.id == null ? "—" : String(album.id);
    }

    formatNumber(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return "0";
        if (number >= 1000000) return `${(number / 1000000).toFixed(1)}m`;
        if (number >= 1000) return `${(number / 1000).toFixed(1)}k`;
        return String(number);
    }
}
