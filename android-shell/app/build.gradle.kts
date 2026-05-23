import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val frontendRoot = file("../../image-studio/frontend")
val versionStamp = SimpleDateFormat("yyyyMMddHHmm", Locale.US).format(Date())
val npmCacheDir = rootProject.file("../.tmp/android-npm-cache")
val frontendInstallTask = tasks.register("prepareFrontendDependencies") {
    group = "frontend"
    outputs.dir(frontendRoot.resolve("node_modules"))
    doLast {
        exec {
            workingDir = frontendRoot
            environment("npm_config_cache", npmCacheDir.absolutePath)
            commandLine("npm", "ci")
        }
    }
}

android {
    namespace = "top.gptcodex.imagestudio.android"
    compileSdk = 34
    buildToolsVersion = "34.0.0"

    defaultConfig {
        applicationId = "top.gptcodex.imagestudio.android"
        minSdk = 28
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-$versionStamp"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    flavorDimensions += "device"

    productFlavors {
        create("phone") {
            dimension = "device"
            applicationIdSuffix = ".phone"
            versionNameSuffix = "-phone"
            manifestPlaceholders["appLabel"] = "Image Studio Phone"
            buildConfigField("String", "TARGET_PLATFORM", "\"android\"")
        }
        create("pad") {
            dimension = "device"
            applicationIdSuffix = ".pad"
            versionNameSuffix = "-pad"
            manifestPlaceholders["appLabel"] = "Image Studio Pad"
            buildConfigField("String", "TARGET_PLATFORM", "\"android-pad\"")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

androidComponents {
    onVariants(selector().all()) { variant ->
        val flavorName = variant.productFlavors.firstOrNull()?.second ?: return@onVariants
        val mode = if (flavorName == "pad") "android-pad" else "android"
        val capFlavor = flavorName.replaceFirstChar { it.uppercaseChar() }
        val capBuild = variant.buildType?.replaceFirstChar { it.uppercaseChar() } ?: "Release"
        val frontendTaskName = "sync${capFlavor}${capBuild}FrontendAssets"
        val frontendDist = frontendRoot.resolve("dist")
        val assetsDir = layout.projectDirectory.dir("src/main/assets/web")
        val variantCapName = variant.name.replaceFirstChar { it.uppercaseChar() }

        val syncTask = tasks.register(frontendTaskName) {
            group = "frontend"
            dependsOn(frontendInstallTask)
            doLast {
                exec {
                    workingDir = frontendRoot
                    environment("npm_config_cache", npmCacheDir.absolutePath)
                    commandLine("npm", "run", "build:$mode")
                }
                delete(assetsDir)
                copy {
                    from(frontendDist)
                    into(assetsDir)
                }
            }
        }

        afterEvaluate {
            listOf(
                "merge${variantCapName}Assets",
                "generate${variantCapName}Assets",
                "package${variantCapName}Assets",
            ).forEach { taskName ->
                tasks.findByName(taskName)?.dependsOn(syncTask)
            }
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.11.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}
