import { jmApi } from "../../api/JmcomicApi.js"
import { lazyLoader } from "../../dom/LazyLoader.js"
import { InfinityScrollContainer } from "../general/InfinityScrollContainer.js"

export class LatestContainerManager{
    containerDom
    scrollContainer
    constructor(){
        this.containerDom=document.querySelector(".latest-cr")
        this.requestVersion=0
        this.scrollContainer=new InfinityScrollContainer({
            container:this.containerDom,
            threshold:100,
            coolingTime:500,
            loadContent:(page)=>this.loadContent(page)
        })
    }
    init(){
        this.scrollContainer.init()
    }

    refresh(){
        this.requestVersion+=1
        this.containerDom.innerHTML='<div class="loading-icon"><i></i><span>正在载入最新内容</span></div>'
        lazyLoader.clear()
        this.scrollContainer.resetAndLoad()
    }

    async loadContent(page,version=this.requestVersion){
        const loading=this.#showLoading()
        try{
            const raw=await jmApi.getLatestContent(page)
            if(version!==this.requestVersion)return
            const list=Array.isArray(raw)?raw:[]
            loading.remove()
            if(!list.length){
                this.scrollContainer.maxPageIndex=page
                return
            }
            const crDom=this.#getComicsCr(list)
            this.containerDom.appendChild(crDom)
            const covers=crDom.querySelectorAll(".cover")
            for(let cover of covers){
                lazyLoader.addCover(cover)
            }
        }catch(error){
            if(version!==this.requestVersion)return
            loading.replaceChildren()
            const message=document.createElement("span")
            message.textContent=error?.message||"最新内容暂时无法载入"
            const retryButton=document.createElement("button")
            retryButton.className="ghost-btn"
            retryButton.type="button"
            retryButton.textContent="重新载入"
            retryButton.addEventListener("click",()=>this.scrollContainer.retry(),{once:true})
            loading.append(message,retryButton)
            throw error
        }
    }
    #showLoading(){
        let loading=this.containerDom.querySelector(".loading-icon")
        if(!loading){
            loading=document.createElement("div")
            loading.className="loading-icon"
            this.containerDom.appendChild(loading)
        }
        loading.replaceChildren()
        const spinner=document.createElement("i")
        const message=document.createElement("span")
        message.textContent="正在载入最新内容"
        loading.append(spinner,message)
        return loading
    }
    #getComicsCr(list){
        const cr=document.createElement("div")
        cr.className="comics-cr"
        cr.innerHTML=this.#getComicsHTML(list)
        return cr
    }
    #getComicsHTML(list){
        return list.map((c)=>`
            <div class="comic-item">
                <a class="cover" data-src="${jmApi.getCoverImageURL(c.id)}" href="./chapter.html?id=${c.id}&v=20260827-7">
                    <img alt="封面"/>
                    <div class="tags"></div>
                </a>
                <h1 class="c-title">${c.name}</h1>
                <h2 class="c-sr-title">${c.author}</h2>
            </div>
        `).join("")
    }
}
