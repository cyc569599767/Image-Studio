export namespace backend {
	
	export class GenerateOptions {
	    apiKey: string;
	    mode: string;
	    prompt: string;
	    size: string;
	    quality: string;
	    outputFormat: string;
	    imagePaths: string[];
	    imagePath: string;
	    maskB64: string;
	    seed: number;
	    negativePrompt: string;
	    baseURL: string;
	    textModelID: string;
	    imageModelID: string;
	    transport: string;
	    apiMode: string;
	    noPromptRevision: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GenerateOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.apiKey = source["apiKey"];
	        this.mode = source["mode"];
	        this.prompt = source["prompt"];
	        this.size = source["size"];
	        this.quality = source["quality"];
	        this.outputFormat = source["outputFormat"];
	        this.imagePaths = source["imagePaths"];
	        this.imagePath = source["imagePath"];
	        this.maskB64 = source["maskB64"];
	        this.seed = source["seed"];
	        this.negativePrompt = source["negativePrompt"];
	        this.baseURL = source["baseURL"];
	        this.textModelID = source["textModelID"];
	        this.imageModelID = source["imageModelID"];
	        this.transport = source["transport"];
	        this.apiMode = source["apiMode"];
	        this.noPromptRevision = source["noPromptRevision"];
	    }
	}
	export class PromptOptimizeOptions {
	    apiKey: string;
	    prompt: string;
	    mode: string;
	    baseURL: string;
	    textModelID: string;
	    imagePaths: string[];
	    imagePath: string;
	
	    static createFrom(source: any = {}) {
	        return new PromptOptimizeOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.apiKey = source["apiKey"];
	        this.prompt = source["prompt"];
	        this.mode = source["mode"];
	        this.baseURL = source["baseURL"];
	        this.textModelID = source["textModelID"];
	        this.imagePaths = source["imagePaths"];
	        this.imagePath = source["imagePath"];
	    }
	}
	export class ImageTransformResult {
	    path: string;
	
	    static createFrom(source: any = {}) {
	        return new ImageTransformResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	    }
	}
	export class ImportedImage {
	    path: string;
	    imageB64: string;
	
	    static createFrom(source: any = {}) {
	        return new ImportedImage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.imageB64 = source["imageB64"];
	    }
	}
	export class JobStarted {
	    jobId: string;
	
	    static createFrom(source: any = {}) {
	        return new JobStarted(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.jobId = source["jobId"];
	    }
	}
	export class SelectFileResponse {
	    path: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new SelectFileResponse(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.size = source["size"];
	    }
	}

}
