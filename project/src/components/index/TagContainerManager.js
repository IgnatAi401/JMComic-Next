export class TagContainerManager {
    tagContainerDom;
    items;

    constructor() {
        this.tagContainerDom = document.querySelector(".tag-cr");
        this.items = [...(this.tagContainerDom?.children || [])];
    }

    init() {
        this.items.forEach((item, index) => {
            item.style.setProperty("--tag-order", index);
        });
    }
}
