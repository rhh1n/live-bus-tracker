package com.citymobility.driver

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object ApiClient {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    fun login(baseUrl: String, pin: String): LoginResult {
        val payload = JSONObject().put("pin", pin)
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/api/driver/login")
            .post(payload.toString().toRequestBody(jsonType))
            .build()

        client.newCall(request).execute().use { res ->
            val body = res.body?.string().orEmpty()
            if (!res.isSuccessful) return LoginResult(false, null, null, "Login failed: ${res.code}")
            val json = JSONObject(body)
            return LoginResult(true, json.optString("token"), json.optString("expiresAt"), null)
        }
    }

    fun uploadLocation(
        baseUrl: String,
        token: String,
        busId: String,
        source: String,
        destination: String,
        lat: Double,
        lng: Double,
        speedKmph: Double,
        headingDeg: Double
    ): ApiResult {
        val payload = JSONObject()
            .put("busId", busId)
            .put("source", source)
            .put("destination", destination)
            .put("lat", lat)
            .put("lng", lng)
            .put("speedKmph", speedKmph)
            .put("headingDeg", headingDeg)

        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/api/driver/location")
            .header("x-driver-token", token)
            .post(payload.toString().toRequestBody(jsonType))
            .build()

        client.newCall(request).execute().use { res ->
            return if (res.isSuccessful) {
                ApiResult(true, null)
            } else {
                ApiResult(false, "Upload failed: ${res.code}")
            }
        }
    }

    fun stopTracking(baseUrl: String, token: String, busId: String): ApiResult {
        val payload = JSONObject().put("busId", busId)
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/api/driver/stop")
            .header("x-driver-token", token)
            .post(payload.toString().toRequestBody(jsonType))
            .build()

        client.newCall(request).execute().use { res ->
            return if (res.isSuccessful) {
                ApiResult(true, null)
            } else {
                ApiResult(false, "Stop failed: ${res.code}")
            }
        }
    }
}

data class LoginResult(
    val ok: Boolean,
    val token: String?,
    val expiresAt: String?,
    val error: String?
)

data class ApiResult(
    val ok: Boolean,
    val error: String?
)

